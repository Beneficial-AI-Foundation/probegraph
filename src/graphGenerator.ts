import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { promisify } from 'util';

const execFile = promisify(cp.execFile);
const exec = promisify(cp.exec);

export interface GraphOptions {
    depth: number;
    filterSources: string;
    outputFormat: 'svg' | 'png' | 'dot';
    includeCallers: boolean;
    includeCallees: boolean;
}

export class CallGraphGenerator {
    private outputDir: string;
    private workspaceRoot: string;
    private rustAnalyzerTestPath: string;
    private scipFilePath: string;

    constructor(outputDir: string, workspaceRoot: string) {
        this.outputDir = outputDir;
        this.workspaceRoot = workspaceRoot;
        this.rustAnalyzerTestPath = path.join(outputDir, 'rust-analyzer-test');
        // Look for the SCIP JSON file in the workspace root
        this.scipFilePath = path.join(workspaceRoot, 'index_scip_curve.json');
    }

    /**
     * Setup rust-analyzer-test by downloading pre-built binary
     */
    async setupRustAnalyzerTest(): Promise<void> {
        try {
            console.log('Setting up rust-analyzer-test...');
            
            // Create directory structure
            const targetDir = path.join(this.rustAnalyzerTestPath, 'target', 'release');
            fs.mkdirSync(targetDir, { recursive: true });
        
        // Determine platform-specific binary name
        const platform = os.platform();
        const arch = os.arch();
        console.log(`Detected platform: ${platform}, architecture: ${arch}`);
        
        // Check if binary already exists
        const existingBinary = path.join(targetDir, 'generate_function_subgraph_dot' + (platform === 'win32' ? '.exe' : ''));
        if (fs.existsSync(existingBinary)) {
            console.log('Binary already exists, skipping download');
            return;
        }
        let binaryName: string;
        let binaryExecutable = 'generate_function_subgraph_dot';
        
        if (platform === 'linux' && arch === 'x64') {
            binaryName = 'generate_function_subgraph_dot-linux-x86_64.tar.gz';
        } else if (platform === 'darwin' && arch === 'x64') {
            binaryName = 'generate_function_subgraph_dot-macos-x86_64.tar.gz';
        } else if (platform === 'darwin' && arch === 'arm64') {
            binaryName = 'generate_function_subgraph_dot-macos-arm64.tar.gz';
        } else if (platform === 'win32' && arch === 'x64') {
            binaryName = 'generate_function_subgraph_dot-windows-x86_64.exe.zip';
            binaryExecutable = 'generate_function_subgraph_dot.exe';
        } else {
            throw new Error(`Unsupported platform: ${platform} ${arch}`);
        }
        
        // Download pre-built binary from GitHub releases
        const releaseVersion = 'v1.0.1';
        const downloadUrl = `https://github.com/Beneficial-AI-Foundation/rust-analyzer-test/releases/download/${releaseVersion}/${binaryName}`;
        const archivePath = path.join(this.outputDir, binaryName);
        
        console.log(`Downloading pre-built binary for ${platform}-${arch} from ${downloadUrl}...`);
        
        // Download the binary archive
        await exec(`curl -L -o "${archivePath}" "${downloadUrl}"`, {
            maxBuffer: 10 * 1024 * 1024 // 10MB buffer
        });
        
        // Verify download
        if (fs.existsSync(archivePath)) {
            const stats = fs.statSync(archivePath);
            console.log(`Downloaded archive: ${archivePath} (${stats.size} bytes)`);
        } else {
            throw new Error(`Failed to download archive: ${archivePath}`);
        }
        
        // Extract the binary based on archive type
        console.log('Extracting binary...');
        if (binaryName.endsWith('.tar.gz')) {
            await exec(`tar -xzf "${archivePath}"`, { 
                cwd: this.outputDir,
                maxBuffer: 1024 * 1024 // 1MB buffer
            });
        } else if (binaryName.endsWith('.zip')) {
            // For Windows, use PowerShell to extract zip
            await exec(`powershell -command "Expand-Archive -Path '${archivePath}' -DestinationPath '${this.outputDir}' -Force"`, {
                maxBuffer: 1024 * 1024 // 1MB buffer
            });
        }
        
        // List extracted contents for debugging
        console.log('Contents after extraction:');
        const extractedContents = fs.readdirSync(this.outputDir);
        console.log(extractedContents);
        
        // Find the binary file more flexibly
        let extractedBinary: string | null = null;
        
        // Recursive function to search for the binary in all directories
        const findBinaryRecursively = (dir: string): string | null => {
            const contents = fs.readdirSync(dir);
            for (const item of contents) {
                const itemPath = path.join(dir, item);
                const stats = fs.statSync(itemPath);
                
                if (stats.isFile()) {
                    if (item === binaryExecutable || item.includes('generate_function_subgraph_dot')) {
                        console.log(`Found binary: ${itemPath}`);
                        return itemPath;
                    }
                } else if (stats.isDirectory()) {
                    const result = findBinaryRecursively(itemPath);
                    if (result) return result;
                }
            }
            return null;
        };
        
        // Look for exact name first
        const expectedBinary = path.join(this.outputDir, binaryExecutable);
        if (fs.existsSync(expectedBinary)) {
            extractedBinary = expectedBinary;
        } else {
            // Search recursively for the binary
            extractedBinary = findBinaryRecursively(this.outputDir);
        }
        
        if (extractedBinary) {
            const targetBinary = path.join(targetDir, 'generate_function_subgraph_dot' + (platform === 'win32' ? '.exe' : ''));
            fs.renameSync(extractedBinary, targetBinary);
            if (platform !== 'win32') {
                fs.chmodSync(targetBinary, 0o755); // Make executable on Unix-like systems
            }
            console.log(`Binary installed successfully: ${targetBinary}`);
        } else {
            console.log('Available files:', extractedContents);
            console.log(`Expected binary name: ${binaryExecutable}`);
            console.log(`Output directory: ${this.outputDir}`);
            console.log(`Archive path: ${archivePath}`);
            
            // List all files recursively for debugging
            const getAllFiles = (dir: string, prefix: string = ''): string[] => {
                const files: string[] = [];
                const contents = fs.readdirSync(dir);
                for (const item of contents) {
                    const itemPath = path.join(dir, item);
                    const stats = fs.statSync(itemPath);
                    if (stats.isFile()) {
                        files.push(prefix + item);
                    } else if (stats.isDirectory()) {
                        files.push(...getAllFiles(itemPath, prefix + item + '/'));
                    }
                }
                return files;
            };
            
            const allFiles = getAllFiles(this.outputDir);
            console.log('All extracted files:', allFiles);
            
            throw new Error(`Failed to find binary in archive. Expected: ${binaryExecutable}, All files: ${allFiles.join(', ')}`);
        }
        
        console.log('rust-analyzer-test setup complete');
        } catch (error: any) {
            console.error('Error setting up rust-analyzer-test:', error);
            throw new Error(`Failed to setup rust-analyzer-test: ${error.message}`);
        }
    }

    /**
     * Check if SCIP data exists in the workspace
     */
    async downloadScipData(): Promise<void> {
        console.log('Checking for SCIP data...');
        
        // Check if SCIP file exists
        if (!fs.existsSync(this.scipFilePath)) {
            const errorMessage = `SCIP index file not found: ${this.scipFilePath}\n\n` +
                `To generate the SCIP index, run one of these commands in your project root:\n\n` +
                `  Using rust-analyzer:\n` +
                `  rust-analyzer scip . && scip print --json index.scip > index_scip_curve.json\n\n` +
                `  Using verus-analyzer:\n` +
                `  verus-analyzer scip . && scip print --json index.scip > index_scip_curve.json\n\n` +
                `After generating the file, try the command again.`;
            throw new Error(errorMessage);
        }
        
        // Verify the file
        const stats = fs.statSync(this.scipFilePath);
        console.log(`SCIP file found (${stats.size} bytes)`);
        
        // Quick validation that it's valid JSON
        try {
            const scipData = JSON.parse(fs.readFileSync(this.scipFilePath, 'utf8'));
            if (!scipData.documents) {
                throw new Error('Invalid SCIP JSON format: missing documents field');
            }
        } catch (error: any) {
            throw new Error(`Invalid SCIP JSON file: ${error.message}`);
        }
    }

    /**
     * Map function name to SCIP symbol using the Python script logic
     */
    async mapFunctionToSymbol(functionName: string): Promise<string | null> {
        console.log(`Mapping function ${functionName} to SCIP symbol...`);
        
        try {
            // Load SCIP data
            const scipData = JSON.parse(fs.readFileSync(this.scipFilePath, 'utf8'));
            const symbols: string[] = [];
            
            // Extract all symbols
            if (scipData.documents) {
                for (const doc of scipData.documents) {
                    if (doc.symbols) {
                        for (const symbol of doc.symbols) {
                            if (symbol.symbol) {
                                symbols.push(symbol.symbol);
                            }
                        }
                    }
                }
            }
            
            console.log(`Loaded ${symbols.length} symbols from SCIP data`);
            
            // Find matching symbols using the same strategy as the Python script
            let matchingSymbols: string[] = [];
            
            // Strategy 1: Look for exact function name in impl context
            for (const s of symbols) {
                if (s.includes(functionName) && (s.includes('impl') || s.toLowerCase().includes('field') || s.toLowerCase().includes('curve25519'))) {
                    matchingSymbols.push(s);
                }
            }
            
            // Strategy 2: If no matches, try broader search
            if (matchingSymbols.length === 0) {
                for (const s of symbols) {
                    if (s.includes(functionName)) {
                        matchingSymbols.push(s);
                    }
                }
            }
            
            // Strategy 3: Try with different casing
            if (matchingSymbols.length === 0) {
                for (const s of symbols) {
                    if (s.toLowerCase().includes(functionName.toLowerCase())) {
                        matchingSymbols.push(s);
                    }
                }
            }
            
            if (matchingSymbols.length > 0) {
                // Prefer symbols with 'impl' or specific project context
                let bestMatch = matchingSymbols[0];
                for (const symbol of matchingSymbols) {
                    if (symbol.includes('impl') || symbol.toLowerCase().includes('curve25519')) {
                        bestMatch = symbol;
                        break;
                    }
                }
                
                console.log(`Found symbol for ${functionName}: ${bestMatch}`);
                return bestMatch;
            } else {
                console.log(`No symbol found for function: ${functionName}`);
                return null;
            }
            
        } catch (error) {
            console.error('Error mapping function to symbol:', error);
            return null;
        }
    }

    /**
     * Generate call graph using the rust-analyzer-test tool
     */
    async generateGraphWithTool(
        functionName: string,
        symbolId: string,
        options: GraphOptions
    ): Promise<string> {
        console.log(`Generating graph for function: ${functionName}`);
        console.log(`Using symbol: ${symbolId}`);
        
        const binaryName = os.platform() === 'win32' ? 'generate_function_subgraph_dot.exe' : 'generate_function_subgraph_dot';
        const toolPath = path.join(this.rustAnalyzerTestPath, 'target', 'release', binaryName);
        const outputDot = path.join(this.outputDir, `${functionName}_${options.depth}.dot`);
        
        // Build command arguments
        const args = [
            this.scipFilePath,
            outputDot,
            symbolId
        ];
        
        // Add filter flag if specified and not 'none'
        if (options.filterSources && options.filterSources !== 'none') {
            args.push(`--${options.filterSources}`);
        }
        
        // Add caller/callee flags based on options
        if (options.includeCallers) {
            args.push('--include-callers');
        }
        if (options.includeCallees) {
            args.push('--include-callees');
        }
        
        args.push('--depth', options.depth.toString());
        
        console.log(`Running: ${toolPath} ${args.join(' ')}`);
        
        try {
            // Run the graph generation tool with increased buffer size
            const result = await execFile(toolPath, args, { 
                timeout: 300000, // 5 minute timeout
                maxBuffer: 50 * 1024 * 1024 // 50MB buffer (default is ~200KB)
            });
            
            // Log some output for debugging (truncated to avoid console spam)
            if (result.stdout) {
                const truncatedOutput = result.stdout.length > 1000 
                    ? result.stdout.substring(0, 1000) + '... (truncated)'
                    : result.stdout;
                console.log(`Tool output: ${truncatedOutput}`);
            }
            
            if (result.stderr) {
                console.log(`Tool stderr: ${result.stderr}`);
            }
            
            if (fs.existsSync(outputDot) && fs.statSync(outputDot).size > 0) {
                console.log(`✓ Successfully generated DOT file for ${functionName}`);
                
                // Convert to the desired format
                let finalPath: string;
                if (options.outputFormat === 'dot') {
                    finalPath = outputDot;
                } else {
                    finalPath = path.join(this.outputDir, `${functionName}_${options.depth}.${options.outputFormat}`);
                    await this.convertDotToFormat(outputDot, finalPath, options.outputFormat);
                }
                
                return finalPath;
            } else {
                throw new Error(`Empty or missing graph file generated for ${functionName}`);
            }
            
        } catch (error: any) {
            // Better error handling for different types of failures
            if (error.code === 'ENOENT') {
                throw new Error(`Graph generation tool not found. Please ensure rust-analyzer-test is properly built.`);
            } else if (error.signal === 'SIGTERM') {
                throw new Error(`Graph generation timed out after 5 minutes for ${functionName}`);
            } else if (error.message && error.message.includes('maxBuffer')) {
                throw new Error(`Graph output too large for ${functionName}. Try reducing the depth or using different filters.`);
            } else {
                console.error(`Failed to generate graph for ${functionName}:`, error);
                throw new Error(`Graph generation failed: ${error.message}`);
            }
        }
    }

    /**
     * Convert DOT file to the desired output format
     */
    private async convertDotToFormat(
        dotPath: string,
        outputPath: string,
        format: string
    ): Promise<void> {
        const args = [`-T${format}`, dotPath, '-o', outputPath];
        
        try {
            await execFile('dot', args);
            console.log(`✓ Converted to ${format}: ${outputPath}`);
        } catch (error: any) {
            throw new Error(`Failed to convert graph to ${format}: ${error.message}`);
        }
    }

    /**
     * Legacy method for compatibility - now uses the new tool-based approach
     */
    async generateGraph(
        functionName: string,
        functionPath: string,
        options: GraphOptions
    ): Promise<string> {
        // Map function to symbol
        const symbolId = await this.mapFunctionToSymbol(functionName);
        if (!symbolId) {
            throw new Error(`Could not find SCIP symbol for function: ${functionName}`);
        }
        
        // Generate graph using the tool
        return this.generateGraphWithTool(functionName, symbolId, options);
    }
}
