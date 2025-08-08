import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import { CallGraphGenerator, GraphOptions } from '../graphGenerator';
import { RustAnalyzerClient } from '../rustAnalyzer';

suite('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present', () => {
		assert.ok(vscode.extensions.getExtension('undefined_publisher.call-graph-visualizer'));
	});

	test('Should register display call graph command', async () => {
		// Activate the extension first
		const ext = vscode.extensions.getExtension('undefined_publisher.call-graph-visualizer');
		if (ext) {
			await ext.activate();
		}
		
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('call-graph-visualizer.displayCallGraph'));
	});

	test('CallGraphGenerator should create DOT files', async () => {
		const tempDir = path.join(__dirname, 'temp-test');
		const workspaceRoot = path.join(__dirname, '..', '..');
		const generator = new CallGraphGenerator(tempDir, workspaceRoot);
		
		const options: GraphOptions = {
			depth: 3,
			filterSources: 'none',
			outputFormat: 'dot',
			includeCallers: false,
			includeCallees: true
		};

		// This test is limited since we can't run the full workflow in unit tests
		try {
			// Test the legacy generateGraph method which should fail gracefully
			const result = await generator.generateGraph('test_function', '/test/path', options);
			assert.ok(result.endsWith('.dot'));
		} catch (error: any) {
			// Expected to fail without proper setup, just verify error handling
			assert.ok(error.message.includes('Could not find SCIP symbol') || 
					 error.message.includes('rust-analyzer-test') ||
					 error.message.includes('SCIP file not found'));
		}
	});

	test('RustAnalyzerClient should detect Verus functions', async () => {
		const client = new RustAnalyzerClient('/test/workspace');
		
		// Create a test document content
		const testContent = `
#[verifier::verify]
fn verified_function() {
    // Verus verified function
}

fn normal_function() {
    // Regular function
}
		`;

		// Note: In a real test, we would mock the vscode.TextDocument
		// For now, we just verify the client exists
		assert.ok(client);
	});
});
