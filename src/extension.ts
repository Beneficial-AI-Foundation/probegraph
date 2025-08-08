// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import { CallGraphGenerator, GraphOptions } from './graphGenerator';
import { RustAnalyzerClient } from './rustAnalyzer';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	console.log('Call Graph Visualizer extension is now active!');

	// Register the command
	const disposable = vscode.commands.registerCommand('call-graph-visualizer.displayCallGraph', async () => {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showErrorMessage('No active text editor found');
			return;
		}

		// Check if it's a Rust file
		if (editor.document.languageId !== 'rust') {
			vscode.window.showErrorMessage('This command only works with Rust files');
			return;
		}

		// Get the current position and document
		const document = editor.document;
		const position = editor.selection.active;

		// Get the word at the current position (function name)
		const wordRange = document.getWordRangeAtPosition(position);
		if (!wordRange) {
			vscode.window.showErrorMessage('No function name found at cursor position');
			return;
		}

		const functionName = document.getText(wordRange);
		
		// Show progress while generating the graph
		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: `Generating call graph for ${functionName}...`,
			cancellable: true
		}, async (progress, token) => {
			try {
				await generateAndDisplayCallGraph(functionName, document.uri, context, token, progress);
			} catch (error: any) {
				vscode.window.showErrorMessage(`Failed to generate call graph: ${error.message}`);
				console.error('Call graph generation error:', error);
			}
		});
	});

	context.subscriptions.push(disposable);
}

async function generateAndDisplayCallGraph(
	functionName: string,
	documentUri: vscode.Uri,
	context: vscode.ExtensionContext,
	cancellationToken: vscode.CancellationToken,
	progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<void> {
	// Create a temporary directory for output
	const tempDir = path.join(os.tmpdir(), 'vscode-call-graphs', Date.now().toString());
	fs.mkdirSync(tempDir, { recursive: true });

	try {
		// Check if required tools are available
		progress.report({ message: 'Checking required tools...' });
		await checkRequiredTools();

		// Get workspace folder
		const workspaceFolder = vscode.workspace.getWorkspaceFolder(documentUri);
		if (!workspaceFolder) {
			throw new Error('No workspace folder found');
		}

		// Initialize the graph generator
		progress.report({ message: 'Initializing graph generator...' });
		const generator = new CallGraphGenerator(tempDir, workspaceFolder.uri.fsPath);

		// Setup rust-analyzer-test repository and tools
		progress.report({ message: 'Setting up rust-analyzer-test tools...' });
		await generator.setupRustAnalyzerTest();

		// Check SCIP data
		progress.report({ message: 'Checking SCIP data...' });
		await generator.downloadScipData();

		// Map function to symbol
		progress.report({ message: 'Mapping function to SCIP symbol...' });
		const symbolMapping = await generator.mapFunctionToSymbol(functionName);
		if (!symbolMapping) {
			throw new Error(`Could not find SCIP symbol for function: ${functionName}`);
		}

		// Generate the call graph with user-configured options
		progress.report({ message: 'Generating call graph...' });
		const config = vscode.workspace.getConfiguration('callGraphVisualizer');
		const options: GraphOptions = {
			depth: config.get('depth', 5),
			filterSources: config.get('filterSources', 'none'),
			outputFormat: config.get('outputFormat', 'svg') as 'svg' | 'png' | 'dot',
			includeCallers: config.get('includeCallers', false),
			includeCallees: config.get('includeCallees', true)
		};

		const graphPath = await generator.generateGraphWithTool(
			functionName,
			symbolMapping,
			options
		);

		// Display the graph in a webview
		progress.report({ message: 'Displaying graph...' });
		showGraphInWebview(functionName, graphPath, context);

	} catch (error) {
		// Clean up temp directory on error
		fs.rmSync(tempDir, { recursive: true, force: true });
		throw error;
	}
}

async function checkRequiredTools(): Promise<void> {
	// Check for cargo (needed for rust projects)
	try {
		await executeCommand('cargo', ['--version']);
	} catch {
		throw new Error('Cargo is not installed. Please install Rust toolchain to use this extension.');
	}

	// Check for curl (needed for downloading binaries)
	try {
		await executeCommand('curl', ['--version']);
	} catch {
		throw new Error('curl is not installed. Please install it to use this extension.');
	}

	// Check for graphviz (dot command)
	try {
		await executeCommand('dot', ['-V']);
	} catch {
		throw new Error('Graphviz is not installed. Please install it to use this extension.');
	}

	// Note: We don't check for SCIP or rust-analyzer/verus-analyzer here
	// because we expect the user to have already generated the SCIP index file.
	// The extension will provide clear instructions if the file is missing.
}

function showGraphInWebview(functionName: string, graphPath: string, context: vscode.ExtensionContext) {
	// Create and show a new webview
	const panel = vscode.window.createWebviewPanel(
		'callGraph',
		`Call Graph: ${functionName}`,
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			localResourceRoots: [vscode.Uri.file(path.dirname(graphPath))]
		}
	);

	// Read the SVG content
	const svgContent = fs.readFileSync(graphPath, 'utf8');

	// Set the webview's HTML content
	panel.webview.html = getWebviewContent(functionName, svgContent);

	// Clean up the temporary files when the panel is closed
	panel.onDidDispose(() => {
		const tempDir = path.dirname(graphPath);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});
}

function getWebviewContent(functionName: string, svgContent: string): string {
	return `<!DOCTYPE html>
	<html lang="en">
	<head>
		<meta charset="UTF-8">
		<meta name="viewport" content="width=device-width, initial-scale=1.0">
		<title>Call Graph: ${functionName}</title>
		<style>
			body {
				margin: 0;
				padding: 20px;
				background-color: var(--vscode-editor-background);
				color: var(--vscode-editor-foreground);
				overflow: auto;
				font-family: var(--vscode-font-family);
			}
			.header {
				margin-bottom: 20px;
				padding-bottom: 15px;
				border-bottom: 1px solid var(--vscode-panel-border);
			}
			h1 {
				font-size: 24px;
				margin: 0 0 10px 0;
				color: var(--vscode-foreground);
			}
			.info {
				font-size: 14px;
				opacity: 0.8;
				margin-bottom: 10px;
			}
			.description {
				font-size: 13px;
				background-color: var(--vscode-textBlockQuote-background);
				padding: 10px;
				border-radius: 4px;
				border-left: 4px solid var(--vscode-textBlockQuote-border);
			}
			.graph-container {
				background-color: white;
				border-radius: 4px;
				padding: 20px;
				display: inline-block;
				box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
				margin: 20px 0;
			}
			svg {
				max-width: 100%;
				height: auto;
			}
			.controls {
				margin-top: 20px;
				padding-top: 15px;
				border-top: 1px solid var(--vscode-panel-border);
			}
			button {
				background-color: var(--vscode-button-background);
				color: var(--vscode-button-foreground);
				border: none;
				padding: 8px 16px;
				border-radius: 4px;
				cursor: pointer;
				margin-right: 10px;
				font-family: var(--vscode-font-family);
			}
			button:hover {
				background-color: var(--vscode-button-hoverBackground);
			}
		</style>
	</head>
	<body>
		<div class="header">
			<h1>Call Graph: ${functionName}</h1>
			<div class="info">
				<p><strong>Graph depth:</strong> 5 | <strong>Filter:</strong> filter-non-libsignal-sources</p>
			</div>
			<div class="description">
				<p><strong>About this graph:</strong></p>
				<ul>
					<li><strong>Nodes:</strong> Functions and their relationships</li>
					<li><strong>Edges:</strong> Call relationships between functions</li>
					<li><strong>Focus:</strong> Paths from Verus-verified functions to libsignal functions</li>
					<li><strong>Generated using:</strong> rust-analyzer-test tool with SCIP analysis</li>
				</ul>
			</div>
		</div>
		<div class="graph-container">
			${svgContent}
		</div>
		<div class="controls">
			<button onclick="zoomIn()">Zoom In</button>
			<button onclick="zoomOut()">Zoom Out</button>
			<button onclick="resetZoom()">Reset</button>
			<button onclick="fitToWindow()">Fit to Window</button>
		</div>
		<script>
			let scale = 1;
			const svg = document.querySelector('svg');
			const container = document.querySelector('.graph-container');
			
			function zoomIn() {
				scale *= 1.2;
				svg.style.transform = \`scale(\${scale})\`;
			}
			
			function zoomOut() {
				scale /= 1.2;
				svg.style.transform = \`scale(\${scale})\`;
			}
			
			function resetZoom() {
				scale = 1;
				svg.style.transform = 'scale(1)';
			}
			
			function fitToWindow() {
				const containerRect = container.getBoundingClientRect();
				const svgRect = svg.getBoundingClientRect();
				const scaleX = (containerRect.width - 40) / svgRect.width;
				const scaleY = (containerRect.height - 40) / svgRect.height;
				scale = Math.min(scaleX, scaleY, 1);
				svg.style.transform = \`scale(\${scale})\`;
			}
		</script>
	</body>
	</html>`;
}

function executeCommand(command: string, args: string[], options?: cp.ExecFileOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		cp.execFile(command, args, options || {}, (error, stdout, stderr) => {
			if (error) {
				reject(new Error(`Command failed: ${error.message}`));
			} else {
				resolve(stdout);
			}
		});
	});
}

// This method is called when your extension is deactivated
export function deactivate() {}
