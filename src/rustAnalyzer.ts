import * as vscode from 'vscode';
import * as cp from 'child_process';
import { promisify } from 'util';

const exec = promisify(cp.exec);

export interface RustFunction {
    name: string;
    fullPath: string;
    file: string;
    line: number;
    column: number;
    isVerus?: boolean;
}

export interface CallRelation {
    from: string;
    to: string;
    file: string;
    line: number;
}

export class RustAnalyzerClient {
    private workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
    }

    /**
     * Check if rust-analyzer is available
     */
    async checkAvailability(): Promise<boolean> {
        try {
            const { stdout } = await exec('rust-analyzer --version');
            console.log('rust-analyzer version:', stdout.trim());
            return true;
        } catch (error) {
            console.error('rust-analyzer not found:', error);
            return false;
        }
    }

    /**
     * Get function information at a specific position
     */
    async getFunctionAtPosition(
        filePath: string,
        line: number,
        column: number
    ): Promise<RustFunction | null> {
        // In a real implementation, this would use the LSP protocol
        // to communicate with rust-analyzer
        
        // For now, parse the file to find function definition
        const document = await vscode.workspace.openTextDocument(filePath);
        const position = new vscode.Position(line, column);
        const wordRange = document.getWordRangeAtPosition(position);
        
        if (!wordRange) {
            return null;
        }

        const word = document.getText(wordRange);
        
        // Check if it's a function by looking at the line
        const lineText = document.lineAt(line).text;
        const functionPattern = /\b(fn|pub\s+fn|async\s+fn|pub\s+async\s+fn)\s+(\w+)/;
        const match = lineText.match(functionPattern);
        
        if (match && match[2] === word) {
            // Check if it's a Verus function
            const isVerus = this.isVerusFunction(document, line);
            
            return {
                name: word,
                fullPath: `${filePath}::${word}`,
                file: filePath,
                line: line,
                column: column,
                isVerus: isVerus
            };
        }

        return null;
    }

    /**
     * Check if a function is a Verus-verified function
     */
    private isVerusFunction(document: vscode.TextDocument, functionLine: number): boolean {
        // Look for Verus annotations above the function
        for (let i = functionLine - 1; i >= Math.max(0, functionLine - 10); i--) {
            const line = document.lineAt(i).text;
            
            // Check for Verus annotations
            if (line.includes('#[verifier::verify]') ||
                line.includes('#[verified]') ||
                line.includes('#[proof]') ||
                line.includes('#[spec]')) {
                return true;
            }
            
            // Stop if we hit another function or struct
            if (/\b(fn|struct|enum|impl|trait)\s+/.test(line)) {
                break;
            }
        }
        
        return false;
    }

    /**
     * Get call graph for a function
     */
    async getCallGraph(
        functionPath: string,
        depth: number = 5
    ): Promise<{ nodes: RustFunction[], edges: CallRelation[] }> {
        // In a real implementation, this would:
        // 1. Use rust-analyzer's analysis-stats or similar functionality
        // 2. Parse SCIP index if available
        // 3. Build the actual call graph
        
        // For now, return a mock structure
        return {
            nodes: [
                {
                    name: functionPath.split('::').pop() || 'unknown',
                    fullPath: functionPath,
                    file: 'src/main.rs',
                    line: 10,
                    column: 0
                }
            ],
            edges: []
        };
    }

    /**
     * Generate SCIP index for the workspace
     */
    async generateScipIndex(): Promise<string> {
        // This would run rust-analyzer with SCIP output
        // For now, return a placeholder path
        return `${this.workspaceRoot}/index.scip`;
    }
}
