import * as path from "path";

import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
    // Tell vscode-neovim to create a debug connection
    process.env.NEOVIM_DEBUG = "1";
    process.env.NODE_ENV = "test";

    try {
        // The folder containing the Extension Manifest package.json
        // Passed to `--extensionDevelopmentPath`
        const extensionDevelopmentPath = path.resolve(__dirname, "../../");

        // The path to the extension test runner script
        // Passed to --extensionTestsPath
        const extensionTestsPath = path.resolve(__dirname, "./suite/index");

        // Download VS Code, unzip it and run the integration test
        await runTests({
            extensionDevelopmentPath,
            extensionTestsPath,
            launchArgs: ["--log", "asvetliakov.vscode-neovim:trace"],
        });
    } catch (err) {
        console.error(err);
        console.error("Failed to run tests");
        process.exit(1);
    }
}

main();
