import * as assert from 'assert';
import { formatTimestamp } from '../../indexLoader';

suite('formatTimestamp', () => {
    test('just now', () => {
        assert.ok(formatTimestamp(new Date()).includes('just now'));
    });

    test('minutes ago', () => {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
        assert.ok(formatTimestamp(fiveMinutesAgo).includes('5 minutes ago'));
    });

    test('hours ago', () => {
        const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
        assert.ok(formatTimestamp(twoHoursAgo).includes('2 hours ago'));
    });
});
