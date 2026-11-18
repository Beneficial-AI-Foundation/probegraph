import { describe, it, expect } from 'vitest';
import { isTestOnlyCfg } from './cfg-predicate';

describe('isTestOnlyCfg', () => {
  it('is true when the gate needs cfg(test) whatever the rest', () => {
    expect(isTestOnlyCfg('test')).toBe(true);
    expect(isTestOnlyCfg('all(test, test)')).toBe(true);
    expect(isTestOnlyCfg('all(test, feature = "std")')).toBe(true);
    expect(isTestOnlyCfg('all(test, all (target_arch = "x86_64" , target_feature = "sse2" ,))')).toBe(true);
    expect(isTestOnlyCfg('not(not(test))')).toBe(true);
    expect(isTestOnlyCfg('any(test, all(test, unix))')).toBe(true);
  });

  it('is false when the item can compile outside test builds', () => {
    expect(isTestOnlyCfg('not(test)')).toBe(false);
    expect(isTestOnlyCfg('feature = "test-utils"')).toBe(false);
    expect(isTestOnlyCfg('any(test, feature = "x")')).toBe(false);
    expect(isTestOnlyCfg('any (target_arch = "x86" , target_arch = "x86_64")')).toBe(false);
    expect(isTestOnlyCfg('testing')).toBe(false);
    expect(isTestOnlyCfg('all()')).toBe(false);
  });

  it('is false for a missing or malformed predicate', () => {
    expect(isTestOnlyCfg(undefined)).toBe(false);
    expect(isTestOnlyCfg('')).toBe(false);
    expect(isTestOnlyCfg('all(test')).toBe(false);
    expect(isTestOnlyCfg('test test')).toBe(false);
    expect(isTestOnlyCfg('foo(test)')).toBe(false);
    expect(isTestOnlyCfg('feature = "unterminated')).toBe(false);
    expect(isTestOnlyCfg('not(test, unix)')).toBe(false);
  });

  it('reads escaped quotes inside strings', () => {
    expect(isTestOnlyCfg('all(test, feature = "a\\"b")')).toBe(true);
  });
});
