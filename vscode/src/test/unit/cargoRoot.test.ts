import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { cargoPackageRoot, nearestCargoDir, parseManifest } from '../../cargoRoot';

suite('parseManifest', () => {
    test('a package', () => {
        const m = parseManifest('[package]\nname = "quicksort" # the name\nversion = "0.1.0"\n\n[dependencies]\n');
        assert.deepStrictEqual(m, { hasPackage: true, packageName: 'quicksort', members: [] });
    });

    test('a workspace with members over several lines and comments', () => {
        const m = parseManifest([
            '# top comment',
            '[workspace]',
            'members = [',
            '    "curve25519-dalek", # "not a member"',
            '    "ed25519-dalek",',
            ']',
            'resolver = "2"',
            '',
            '[profile.dev]',
            'opt-level = 2',
        ].join('\n'));
        assert.deepStrictEqual(m, { hasPackage: false, members: ['curve25519-dalek', 'ed25519-dalek'] });
    });

    test('a workspace that is also a package', () => {
        const m = parseManifest('[workspace]\nmembers = ["sub"]\n\n[package]\nname = "root"\n');
        assert.strictEqual(m.hasPackage, true);
        assert.strictEqual(m.packageName, 'root');
    });

    test('a name in another table is not the package name', () => {
        const m = parseManifest('[package]\nversion = "1"\n[dependencies.serde]\nname = "x"\n');
        assert.strictEqual(m.packageName, undefined);
    });
});

suite('cargoPackageRoot', () => {
    let dir: string;

    setup(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cargo-root-'));
    });

    teardown(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function crate(name: string, rel = name): string {
        const d = path.join(dir, rel);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'Cargo.toml'), `[package]\nname = "${name}"\n`);
        return d;
    }

    test('a package is its own root', () => {
        const root = crate('solo');
        assert.strictEqual(cargoPackageRoot(root), root);
        assert.strictEqual(cargoPackageRoot(root, 'other'), root);
    });

    test('no Cargo.toml: the directory itself', () => {
        assert.strictEqual(cargoPackageRoot(dir), dir);
    });

    test('a workspace with one member resolves to it, as probe-verus does', () => {
        const member = crate('curve25519-dalek');
        fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[workspace]\nmembers = ["curve25519-dalek"]\n');
        assert.strictEqual(cargoPackageRoot(dir), member);
    });

    test('a workspace with several members needs the package name', () => {
        crate('alpha', 'crates/alpha');
        const beta = crate('beta', 'crates/beta');
        fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[workspace]\nmembers = ["crates/alpha", "crates/beta"]\n');
        assert.strictEqual(cargoPackageRoot(dir), dir, 'without a name the rule cannot decide');
        assert.strictEqual(cargoPackageRoot(dir, 'beta'), beta);
        assert.strictEqual(cargoPackageRoot(dir, 'gamma'), dir);
    });

    test('a single member that does not exist is not a root', () => {
        fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[workspace]\nmembers = ["missing"]\n');
        assert.strictEqual(cargoPackageRoot(dir), dir);
    });

    test('nearestCargoDir walks up to the top, inclusive', () => {
        const member = crate('inner', 'ws/inner');
        const deep = path.join(member, '.verilib', 'probes');
        fs.mkdirSync(deep, { recursive: true });
        assert.strictEqual(nearestCargoDir(dir, deep), member);
        assert.strictEqual(nearestCargoDir(dir, path.join(dir, 'ws')), undefined);
        fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[workspace]\n');
        assert.strictEqual(nearestCargoDir(dir, path.join(dir, 'ws')), dir);
        assert.strictEqual(nearestCargoDir(member, member), member);
    });
});
