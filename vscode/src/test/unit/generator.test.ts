import * as assert from 'assert';
import { missingFromStatus } from '../../generator';

suite('missingFromStatus', () => {
    // The shape of `probe-verus setup --status` (print_status in probe-verus)
    const report = [
        'Managed tools directory: /home/u/.local/share/probe-verus/tools',
        '',
        'Tool                 Install version    Status     Location',
        '-'.repeat(78),
        'verus-analyzer       2026-02-03 (default) managed    /home/u/.local/share/probe-verus/tools/verus-analyzer',
        'scip                 v0.5.2 (default)   PATH       /usr/bin/scip',
        'verus                release/0.2026.01 (default) missing    -',
        'Rust toolchain required by Verus release/0.2026.01: 1.88.0',
        '  Status: NOT INSTALLED (run `probe-verus setup` to install)',
        '',
        'Override versions with environment variables:',
        '  PROBE_VERUS_VERUS_VERSION=<tag>',
    ].join('\n');

    test('names the missing tools and the uninstalled toolchain', () => {
        assert.deepStrictEqual(missingFromStatus(report), ['verus', 'Rust toolchain 1.88.0']);
    });

    test('an installed toolchain is not missing', () => {
        const installed = report.replace(
            '  Status: NOT INSTALLED (run `probe-verus setup` to install)',
            '  Installed: rustc 1.88.0 (abc 2026-01-01)',
        );
        assert.deepStrictEqual(missingFromStatus(installed), ['verus']);
    });

    test('nothing missing', () => {
        assert.deepStrictEqual(missingFromStatus('verus-analyzer  x  managed  /a\nscip  x  PATH  /b\n'), []);
    });
});
