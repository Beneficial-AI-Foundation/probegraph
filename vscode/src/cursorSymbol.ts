/**
 * The declaration enclosing a position, from the language server's document
 * symbols (rust-analyzer, the Lean 4 server).
 */

import * as vscode from 'vscode';
import type { EditorSymbol } from '../../web/src/editor-lookup';

/** Symbols that are never graph nodes themselves, only around them or inside them. */
const NOT_DECLARATIONS = new Set([
    vscode.SymbolKind.File,
    vscode.SymbolKind.Module,
    vscode.SymbolKind.Namespace,
    vscode.SymbolKind.Package,
    vscode.SymbolKind.Field,
    vscode.SymbolKind.Variable,
    vscode.SymbolKind.TypeParameter,
    vscode.SymbolKind.EnumMember,
    vscode.SymbolKind.Key,
    vscode.SymbolKind.Null,
]);

/**
 * The innermost declaration-like symbol containing the position, with the
 * names of the symbols around it. Undefined when the language server has no
 * symbols (not started, still elaborating) or none contains the position.
 */
export async function enclosingSymbol(
    document: vscode.TextDocument,
    position: vscode.Position
): Promise<EditorSymbol | undefined> {
    let symbols: (vscode.DocumentSymbol | vscode.SymbolInformation)[] | undefined;
    try {
        symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
    } catch {
        return undefined;
    }
    if (!symbols || symbols.length === 0) {
        return undefined;
    }
    return 'children' in symbols[0]
        ? fromTree(symbols as vscode.DocumentSymbol[], position)
        : fromFlat(symbols as vscode.SymbolInformation[], position);
}

function fromTree(symbols: vscode.DocumentSymbol[], position: vscode.Position): EditorSymbol | undefined {
    let found: EditorSymbol | undefined;
    const containers: string[] = [];
    let level = symbols;
    for (;;) {
        const hit = level.find(s => s.range.contains(position));
        if (!hit) {
            return found;
        }
        if (!NOT_DECLARATIONS.has(hit.kind)) {
            found = { name: hit.name, containers: [...containers] };
        }
        containers.push(hit.name);
        level = hit.children;
    }
}

function fromFlat(symbols: vscode.SymbolInformation[], position: vscode.Position): EditorSymbol | undefined {
    const hits = symbols
        .filter(s => !NOT_DECLARATIONS.has(s.kind) && s.location.range.contains(position))
        .sort((a, b) => (a.location.range.end.line - a.location.range.start.line)
            - (b.location.range.end.line - b.location.range.start.line));
    const hit = hits[0];
    return hit && { name: hit.name, containers: hit.containerName ? [hit.containerName] : [] };
}
