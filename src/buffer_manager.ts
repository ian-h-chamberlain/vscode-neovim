import { debounce } from "lodash";
import { Buffer, NeovimClient, Window } from "neovim";
import { commands, Disposable, EndOfLine, TextDocument, TextEditor, Uri, ViewColumn, window, workspace } from "vscode";

import { Logger } from "./logger";
import { NeovimExtensionRequestProcessable, NeovimRedrawProcessable } from "./neovim_events_processable";
import { callAtomic, getNeovimCursorPosFromEditor } from "./utils";

// !Note: document and editors in vscode events and namespace are reference stable

export interface BufferManagerSettings {
    neovimViewportWidth: number;
    neovimViewportHeight: number;
}

const LOG_PREFIX = "BufferManager";

/**
 * Manages neovim buffers and windows and maps them to vscode editors & documents
 */
export class BufferManager implements Disposable, NeovimRedrawProcessable, NeovimExtensionRequestProcessable {
    private disposables: Disposable[] = [];
    /**
     * Internal sync promise
     */
    private changeLayoutPromise?: Promise<void>;
    private changeLayoutPromiseResolve?: () => void;
    /**
     * Currently opened editors
     * !Note: Order can be any, it doesn't relate to visible order
     */
    private openedEditors: TextEditor[] = [];
    /**
     * Mapping of vscode documents -> neovim buffer id
     */
    private textDocumentToBufferId: Map<TextDocument, number> = new Map();
    /**
     * Mapping of editor column -> neovim win id
     */
    private editorColumnsToWinId: Map<number, number> = new Map();
    /**
     * Mapping of vscode "temp" (without viewColumn) editor -> win id
     */
    private noColumnEditorsToWinId: Map<TextEditor, number> = new Map();
    /**
     * Current grid configurations
     */
    private grids: Map<number, { winId: number }> = new Map();

    /**
     * Buffer event delegate
     */
    public onBufferEvent?: (
        bufId: number,
        tick: number,
        firstLine: number,
        lastLine: number,
        linedata: string[],
        more: boolean,
    ) => void;

    public onBufferInit?: (bufferId: number, textDocument: TextDocument) => void;

    public constructor(private logger: Logger, private client: NeovimClient, private settings: BufferManagerSettings) {
        this.disposables.push(window.onDidChangeVisibleTextEditors(this.onDidChangeVisibleTextEditors));
        this.disposables.push(window.onDidChangeActiveTextEditor(this.onDidChangeActiveTextEditor));
        this.disposables.push(workspace.onDidCloseTextDocument(this.onDidCloseTextDocument));
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    public forceResync(): void {
        this.logger.debug(`${LOG_PREFIX}: force resyncing layout`);
        this.onDidChangeVisibleTextEditors();
        this.onDidChangeActiveTextEditor();
    }

    public async waitForLayoutSync(): Promise<void> {
        if (this.changeLayoutPromise) {
            this.logger.debug(`${LOG_PREFIX}: Waiting for completing layout resyncing`);
            await this.changeLayoutPromise;
        }
    }

    public getTextDocumentForBufferId(id: number): TextDocument | undefined {
        const doc = [...this.textDocumentToBufferId].find(([, bufId]) => id === bufId)?.[0];
        return doc && !doc.isClosed ? doc : undefined;
    }

    public getBufferIdForTextDocument(doc: TextDocument): number | undefined {
        return this.textDocumentToBufferId.get(doc);
    }

    public getGridIdForWinId(winId: number): number | undefined {
        const grid = [...this.grids].find(([, conf]) => conf.winId === winId);
        return grid ? grid[0] : undefined;
    }

    public getWinIdForGridId(gridId: number): number | undefined {
        return this.grids.get(gridId)?.winId;
    }

    public getWinIdForTextEditor(editor: TextEditor): number | undefined {
        if (editor.viewColumn) {
            return this.editorColumnsToWinId.get(editor.viewColumn);
        } else {
            return this.noColumnEditorsToWinId.get(editor);
        }
    }

    public getEditorFromWinId(winId: number): TextEditor | undefined {
        // try first noColumnEditors
        const noColumnEditor = [...this.noColumnEditorsToWinId].find(([, id]) => id === winId);
        if (noColumnEditor) {
            return noColumnEditor[0];
        }
        const viewColumnId = [...this.editorColumnsToWinId].find(([, id]) => id === winId)?.[0];
        if (!viewColumnId) {
            return;
        }
        const editor = this.openedEditors.find((e) => e.viewColumn === viewColumnId);
        return editor;
    }

    public getEditorFromGridId(gridId: number): TextEditor | undefined {
        const winId = this.getWinIdForGridId(gridId);
        if (!winId) {
            return;
        }
        return this.getEditorFromWinId(winId);
    }

    public isExternalTextDocument(textDoc: TextDocument): boolean {
        return false;
    }

    public handleRedrawBatch(batch: [string, ...unknown[]][]): void {
        for (const [name, ...args] of batch) {
            // const firstArg = args[0] || [];
            switch (name) {
                case "win_external_pos":
                case "win_pos": {
                    for (const [grid, win] of args as [number, Window][]) {
                        this.grids.set(grid, { winId: win.id });
                    }
                    break;
                }
                case "win_close": {
                    for (const [grid] of args as [number][]) {
                        this.grids.delete(grid);
                    }
                    break;
                }
            }
        }
    }

    public async handleExtensionRequest(name: string, args: unknown[]): Promise<void> {
        switch (name) {
            case "open-file": {
                const [fileName, close] = args as [string, number | "all"];
                const currEditor = window.activeTextEditor;
                let doc: TextDocument | undefined;
                if (fileName === "__vscode_new__") {
                    doc = await workspace.openTextDocument();
                } else {
                    doc = await workspace.openTextDocument(fileName.trim());
                }
                if (!doc) {
                    return;
                }
                let viewColumn: ViewColumn | undefined;
                if (close && close !== "all" && currEditor) {
                    viewColumn = currEditor.viewColumn;
                    await commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
                }
                await window.showTextDocument(doc, viewColumn);
                if (close === "all") {
                    await commands.executeCommand("workbench.action.closeOtherEditors");
                }
                break;
            }
            case "external-buffer": {
                const [name, idStr, expandTab, tabStop, isJumping] = args as [string, string, number, number, number];
                const id = parseInt(idStr, 10);
                if (!(name && /:\/\//.test(name))) {
                    this.logger.debug(`${LOG_PREFIX}: Attaching new external buffer: ${name}`);
                    await this.attachNeovimExternalBuffer(name, id, !!expandTab, tabStop);
                } else if (isJumping && name) {
                    this.logger.debug(`${LOG_PREFIX}: Opening a ${name} because of jump`);
                    // !Important: we only allow to open uri from neovim side when jumping. Otherwise it may break vscode editor management
                    // !and produce ugly switching effects
                    try {
                        let doc = workspace.textDocuments.find((d) => d.uri.toString() === name);
                        if (!doc) {
                            this.logger.debug(`${LOG_PREFIX}: Opening a doc: ${name}`);
                            doc = await workspace.openTextDocument(Uri.parse(name, true));
                        }
                        let forceTabOptions = false;
                        if (!this.textDocumentToBufferId.has(doc)) {
                            this.logger.debug(
                                `${LOG_PREFIX}: No doc -> buffer mapping exists, assigning mapping and init buffer options`,
                            );
                            const buffers = await this.client.buffers;
                            const buf = buffers.find((b) => b.id === id);
                            if (buf) {
                                forceTabOptions = true;
                                await this.initBufferForDocument(doc, buf);
                            }
                            this.textDocumentToBufferId.set(doc, id);
                        }
                        // this.skipJumpsForUris.set(name, true);
                        const editor = await window.showTextDocument(doc, {
                            // viewColumn: vscode.ViewColumn.Active,
                            // !need to force editor to appear in the same column even if vscode 'revealIfOpen' setting is true
                            viewColumn: window.activeTextEditor
                                ? window.activeTextEditor.viewColumn
                                : ViewColumn.Active,
                            preserveFocus: false,
                            preview: false,
                        });
                        if (forceTabOptions) {
                            await this.resyncBufferTabOptions(editor, id);
                        }
                    } catch {
                        // todo: show error
                    }
                }
                break;
            }
        }
    }

    private onDidCloseTextDocument = (e: TextDocument): void => {
        this.textDocumentToBufferId.delete(e);
    };

    private onDidChangeVisibleTextEditors = (): void => {
        // !since onDidChangeVisibleTextEditors/onDidChangeActiveTextEditor are synchronyous
        // !and we debounce this event, and possible init new buffers in neovim in async way
        // !we need to wait to complete last call before processing onDidChangeActiveTextEditor
        // !for this init a promise early, then resolve it after processing
        this.logger.debug(`${LOG_PREFIX}: onDidChangeVisibleTextEditors`);
        if (!this.changeLayoutPromise) {
            this.changeLayoutPromise = new Promise((res) => (this.changeLayoutPromiseResolve = res));
        }
        this.syncLayout();
    };

    private onDidChangeActiveTextEditor = (): void => {
        this.logger.debug(`${LOG_PREFIX}: onDidChangeActiveTextEditor`);
        this.syncActiveEditor();
    };

    // ! we're interested only in the editor final layout and vscode may call this function few times, e.g. when moving an editor to other group
    // ! so lets debounce it slightly
    private syncLayout = debounce(
        async () => {
            this.logger.debug(`${LOG_PREFIX}: syncing layout`);
            // store in copy, just in case
            const currentVisibleEditors = [...window.visibleTextEditors];
            const prevVisibleEditors = this.openedEditors;
            // ! need to:
            // ! 1. Switch editors in neovim windows if vscode editor column was changed
            // ! 2. Delete any closed editor column in neovim
            // ! We're forcing bufhidden=wipe, so no need to close buffers manually

            const nvimRequests: [string, unknown[]][] = [];
            // Open/change neovim windows
            this.logger.debug(`${LOG_PREFIX}: new/changed editors/windows`);
            // store currently visible viewColumns, doesn't include undefined viewColumns
            const keepViewColumns: Set<number> = new Set();
            for (const visibleEditor of currentVisibleEditors) {
                this.logger.debug(
                    `${LOG_PREFIX}: Visible editor, viewColumn: ${
                        visibleEditor.viewColumn
                    }, doc: ${visibleEditor.document.uri.toString()}`,
                );
                // create buffer first if not known to the system
                // creating initially not listed buffer to prevent firing autocmd events when
                // buffer name/lines are not yet set. We'll set buflisted after setup
                if (!this.textDocumentToBufferId.has(visibleEditor.document)) {
                    this.logger.debug(`${LOG_PREFIX}: Document not known, init in neovim`);
                    const buf = await this.client.createBuffer(false, true);
                    if (typeof buf === "number") {
                        this.logger.error(`${LOG_PREFIX}: Cannot create a buffer, code: ${buf}`);
                        continue;
                    }
                    await this.initBufferForDocument(visibleEditor.document, buf, visibleEditor);

                    this.logger.debug(
                        `${LOG_PREFIX}: Document: ${visibleEditor.document.uri.toString()}, BufId: ${buf.id}`,
                    );
                    this.textDocumentToBufferId.set(visibleEditor.document, buf.id);
                }
                // editor wasn't changed, skip
                if (prevVisibleEditors.includes(visibleEditor)) {
                    this.logger.debug(`${LOG_PREFIX}: Editor wasn't changed, skip`);
                    continue;
                }
                const editorBufferId = this.textDocumentToBufferId.get(visibleEditor.document)!;
                let winId: number | undefined;
                try {
                    // System editor, like peek view, search results, etc, has undefined viewColumn and we should always create new window for it
                    if (!visibleEditor.viewColumn || !this.editorColumnsToWinId.has(visibleEditor.viewColumn)) {
                        this.logger.debug(
                            `${LOG_PREFIX}: Creating new neovim window for ${visibleEditor.viewColumn} column (undefined is OK here)`,
                        );
                        winId = await this.createNeovimWindow();
                        if (visibleEditor.viewColumn) {
                            this.editorColumnsToWinId.set(visibleEditor.viewColumn, winId);
                        } else {
                            this.noColumnEditorsToWinId.set(visibleEditor, winId);
                        }
                        this.logger.debug(`${LOG_PREFIX}: ViewColumn: ${visibleEditor.viewColumn} - WinId: ${winId}`);
                    } else {
                        winId = this.editorColumnsToWinId.get(visibleEditor.viewColumn);
                    }

                    if (!winId) {
                        throw new Error("Invalid neovim window for editor");
                    }
                    if (visibleEditor.viewColumn) {
                        keepViewColumns.add(visibleEditor.viewColumn);
                    }

                    const cursor = getNeovimCursorPosFromEditor(visibleEditor);
                    this.logger.debug(
                        `${LOG_PREFIX}: Setting buffer: ${editorBufferId} to win: ${winId}, cursor: [${cursor[0]}, ${cursor[1]}]`,
                    );

                    nvimRequests.push(
                        ["nvim_win_set_buf", [winId, editorBufferId]],
                        ["nvim_win_set_cursor", [winId, getNeovimCursorPosFromEditor(visibleEditor)]],
                    );
                } catch (e) {
                    this.logger.error(`${LOG_PREFIX}: ${e.message}`);
                    continue;
                }
            }

            this.logger.debug(`${LOG_PREFIX}: Closing non visible editors`);
            // close any non visible neovim windows
            for (const prevVisibleEditor of prevVisibleEditors) {
                // still visible, skip
                if (currentVisibleEditors.includes(prevVisibleEditor)) {
                    this.logger.debug(
                        `${LOG_PREFIX}: Editor viewColumn: ${prevVisibleEditor.viewColumn}, visibility hasn't changed, skip`,
                    );
                    continue;
                }
                const document = prevVisibleEditor.document;
                if (!currentVisibleEditors.find((e) => e.document === document)) {
                    this.logger.debug(
                        `${LOG_PREFIX}: Document ${document.uri.toString()} is not visible, removing mapping to bufId: ${this.textDocumentToBufferId.get(
                            document,
                        )}`,
                    );
                    this.textDocumentToBufferId.delete(document);
                }
                if (!prevVisibleEditor.viewColumn || !keepViewColumns.has(prevVisibleEditor.viewColumn)) {
                    const winId = prevVisibleEditor.viewColumn
                        ? this.editorColumnsToWinId.get(prevVisibleEditor.viewColumn)
                        : this.noColumnEditorsToWinId.get(prevVisibleEditor);

                    if (!winId) {
                        continue;
                    }
                    if (prevVisibleEditor.viewColumn) {
                        this.editorColumnsToWinId.delete(prevVisibleEditor.viewColumn);
                    } else {
                        this.noColumnEditorsToWinId.delete(prevVisibleEditor);
                    }

                    this.logger.debug(
                        `${LOG_PREFIX}: Editor viewColumn: ${prevVisibleEditor.viewColumn}, winId: ${winId}, closing`,
                    );
                    nvimRequests.push(["nvim_win_close", [winId, true]]);
                }
            }
            await callAtomic(this.client, nvimRequests, this.logger, LOG_PREFIX);

            // remember new visible editors
            this.openedEditors = currentVisibleEditors;
            if (this.changeLayoutPromiseResolve) {
                this.changeLayoutPromiseResolve();
            }
            this.changeLayoutPromise = undefined;
        },
        100,
        { leading: false, trailing: true },
    );

    private syncActiveEditor = debounce(
        async () => {
            this.logger.debug(`${LOG_PREFIX}: syncing active editor`);
            if (this.changeLayoutPromise) {
                await this.changeLayoutPromise;
            }
            const activeEditor = window.activeTextEditor;
            if (!activeEditor) {
                return;
            }
            const winId = activeEditor.viewColumn
                ? this.editorColumnsToWinId.get(activeEditor.viewColumn)
                : this.noColumnEditorsToWinId.get(activeEditor);
            if (!winId) {
                this.logger.error(
                    `${LOG_PREFIX}: Unable to determine neovim windows id for editor viewColumn: ${
                        activeEditor.viewColumn
                    }, docUri: ${activeEditor.document.uri.toString()}`,
                );
                return;
            }
            const cursor = getNeovimCursorPosFromEditor(activeEditor);
            this.logger.debug(
                `${LOG_PREFIX}: Setting active editor - viewColumn: ${activeEditor.viewColumn}, winId: ${winId}, cursor: [${cursor[0]}, ${cursor[1]}]`,
            );
            await this.client.request("nvim_set_current_win", [winId]);
        },
        50,
        { leading: false, trailing: true },
    );

    private receivedBufferEvent = (
        buffer: Buffer,
        tick: number,
        firstLine: number,
        lastLine: number,
        linedata: string[],
        more: boolean,
    ): void => {
        this.onBufferEvent && this.onBufferEvent(buffer.id, tick, firstLine, lastLine, linedata, more);
    };

    /**
     * Set buffer options from vscode document
     * @param document
     */
    private async initBufferForDocument(document: TextDocument, buffer: Buffer, editor?: TextEditor): Promise<void> {
        const bufId = buffer.id;
        this.logger.debug(`${LOG_PREFIX}: Init buffer for ${bufId}, doc: ${document.uri.toString()}`);

        // !In vscode same document can have different insertSpaces/tabSize settings per editor
        // !however in neovim it's per buffer. We make assumption here that these settings are same for all editors
        // !It's possible to set expandtab/tabstop/shiftwidth when switching editors, but rare case
        const {
            options: { insertSpaces, tabSize },
        } = editor || { options: { insertSpaces: true, tabSize: 4 } };
        const eol = document.eol === EndOfLine.LF ? "\n" : "\r\n";
        const lines = document.getText().split(eol);

        const requests: [string, unknown[]][] = [
            ["nvim_buf_set_option", [bufId, "expandtab", insertSpaces]],
            // we must use tabstop with value 1 so one tab will be counted as one character for highlight
            ["nvim_buf_set_option", [bufId, "tabstop", insertSpaces ? tabSize : 1]],
            // same for shiftwidth - don't want to shift more than one tabstop
            ["nvim_buf_set_option", [bufId, "shiftwidth", insertSpaces ? (tabSize as number) : 1]],
            // fill the buffer
            ["nvim_buf_set_lines", [bufId, 0, 1, false, lines]],
            // set vscode controlled flag so we can check it neovim
            ["nvim_buf_set_var", [bufId, "vscode_controlled", true]],
            // buffer name = document URI
            ["nvim_buf_set_name", [bufId, document.uri.toString()]],
            // clear undo after setting initial lines
            ["nvim_call_function", ["VSCodeClearUndo", [bufId]]],
            // list buffer
            ["nvim_buf_set_option", [bufId, "buflisted", true]],
        ];
        await callAtomic(this.client, requests, this.logger, LOG_PREFIX);
        if (this.onBufferInit) {
            this.onBufferInit(bufId, document);
        }
        // start listen for buffer changes
        buffer.listen("lines", this.receivedBufferEvent);
    }

    private async resyncBufferTabOptions(editor: TextEditor, bufId: number): Promise<void> {
        const {
            options: { insertSpaces, tabSize },
        } = editor;

        const requests: [string, unknown[]][] = [
            ["nvim_buf_set_option", [bufId, "expandtab", insertSpaces]],
            // we must use tabstop with value 1 so one tab will be counted as one character for highlight
            ["nvim_buf_set_option", [bufId, "tabstop", insertSpaces ? tabSize : 1]],
            // same for shiftwidth - don't want to shift more than one tabstop
            ["nvim_buf_set_option", [bufId, "shiftwidth", insertSpaces ? (tabSize as number) : 1]],
        ];
        await callAtomic(this.client, requests, this.logger, LOG_PREFIX);
    }

    /**
     * Create new neovim window
     * !Note: Since we need to know winId before setting actual buffer to it, first create temporary scratch buffer for this window
     * !Later we set actual buffer to this window and temporary buffer will be wiped out
     */
    private async createNeovimWindow(): Promise<number> {
        const buf = await this.client.createBuffer(true, true);
        if (typeof buf === "number") {
            throw new Error(`Unable to create a temporary buffer for new neovim window, code: ${buf}`);
        }
        const win = await this.client.openWindow(buf, false, {
            external: true,
            width: this.settings.neovimViewportWidth,
            height: this.settings.neovimViewportHeight,
        });
        if (typeof win === "number") {
            throw new Error(`Unable to create a new neovim window, code: ${win}`);
        }
        await callAtomic(
            this.client,
            [
                ["nvim_win_set_var", [win.id, "vscode_clearjumps", true]],
                ["nvim_buf_set_option", [buf.id, "vscode_temp", true]],
                ["nvim_buf_set_option", [buf.id, "hidden", false]],
                ["nvim_buf_set_option", [buf.id, "bufhidden", "wipe"]],
            ],
            this.logger,
            LOG_PREFIX,
        );
        return win.id;
    }

    private async attachNeovimExternalBuffer(
        name: string,
        id: number,
        expandTab: boolean,
        tabStop: number,
    ): Promise<void> {
        // // already processed
        // if (this.bufferIdToUri.has(id)) {
        //     const uri = this.bufferIdToUri.get(id)!;
        //     const buf = this.uriToBuffer.get(uri);
        //     if (!buf) {
        //         return;
        //     }
        //     const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri);
        //     if (doc) {
        //         // vim may send two requests, for example for :help - first it opens buffer with empty content in new window
        //         // then read file and reload the buffer
        //         const lines = await buf.lines;
        //         const editor = await vscode.window.showTextDocument(doc, {
        //             preserveFocus: false,
        //             preview: true,
        //             viewColumn: vscode.ViewColumn.Active,
        //         });
        //         // need always to use spaces otherwise col will be different and vim HL will be incorrect
        //         editor.options.insertSpaces = true;
        //         editor.options.tabSize = tabStop;
        //         // using replace produces ugly selection effect, try to avoid it by using insert
        //         editor.edit((b) => b.insert(new vscode.Position(0, 0), lines.join("\n")));
        //         vscode.commands.executeCommand("editor.action.indentationToSpaces");
        //     }
        //     return;
        // }
        // // if (!name) {
        // // return;
        // // }
        // const buffers = await this.client.buffers;
        // // get buffer handle
        // const buf = buffers.find((b) => b.id === id);
        // if (!buf) {
        //     return;
        // }
        // // :help, PlugStatus etc opens new window. close it and attach to existing window instead
        // const windows = await this.client.windows;
        // const possibleBufWindow = windows.find(
        //     (w) => ![...this.editorColumnIdToWinId].find(([, winId]) => w.id === winId),
        // );
        // if (possibleBufWindow && vscode.window.activeTextEditor) {
        //     const winBuf = await possibleBufWindow.buffer;
        //     if (winBuf.id === buf.id) {
        //         const column = vscode.window.activeTextEditor.viewColumn || vscode.ViewColumn.One;
        //         const winId = this.editorColumnIdToWinId.get(column)!;
        //         await this.client.callAtomic([
        //             ["nvim_win_set_buf", [winId, buf.id]],
        //             ["nvim_win_close", [possibleBufWindow.id, false]],
        //         ]);
        //         // await this.client.request("nvim_win_close", [possibleBufWindow.id, false]);
        //     }
        // }
        // // we want to send initial buffer content with nvim_buf_lines event but listen("lines") doesn't support it
        // const p = buf[ATTACH](true);
        // // this.client.attachBuffer(buf, "lines", this.onNeovimBufferEvent);
        // await p;
        // // buf.listen("lines", this.onNeovimBufferEvent);
        // const lines = await buf.lines;
        // // will trigger onOpenTextDocument but it's fine since the doc is not yet displayed and we won't process it
        // const doc = await vscode.workspace.openTextDocument({
        //     content: lines.join("\n"),
        // });
        // const uri = doc.uri.toString();
        // this.uriToBuffer.set(uri, buf);
        // this.bufferIdToUri.set(id, uri);
        // if (!lines.length || lines.every((l) => !l.length)) {
        //     this.externalBuffersShowOnNextChange.add(buf.id);
        // } else {
        //     const editor = await vscode.window.showTextDocument(doc, {
        //         preserveFocus: false,
        //         preview: true,
        //         viewColumn: vscode.ViewColumn.Active,
        //     });
        //     // need always to use spaces otherwise col will be different and vim HL will be incorrect
        //     editor.options.insertSpaces = true;
        //     editor.options.tabSize = tabStop;
        //     vscode.commands.executeCommand("editor.action.indentationToSpaces");
        // }
    }
}
