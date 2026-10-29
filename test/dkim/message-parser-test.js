'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

//let http = require('http');
const MessageParser = require('../../lib/dkim/message-parser');

describe('DKIM MessageParser Tests', () => {
    it('should extract header and body', (t, done) => {
        let parser = new MessageParser();
        let message = `From: saatja aadress
To: Saaja aadress
Subject: pealkiri
  mitmel
  real
Message-Id: test

tere tere
teine rida
`;

        let chunks = [];
        let headers = false;
        let end = false;

        parser.on('data', chunk => {
            chunks.push(chunk);
        });

        parser.on('end', () => {
            end = true;
            let body = Buffer.concat(chunks).toString();
            assert.strictEqual(body, 'tere tere\nteine rida\n');
            if (headers) {
                return done();
            }
        });

        parser.on('headers', data => {
            assert.deepStrictEqual(data, [
                // fix auto format
                {
                    key: 'from',
                    line: 'From: saatja aadress'
                },
                {
                    key: 'to',
                    line: 'To: Saaja aadress'
                },
                {
                    key: 'subject',
                    line: 'Subject: pealkiri\n  mitmel\n  real'
                },
                {
                    key: 'message-id',
                    line: 'Message-Id: test'
                }
            ]);
            headers = true;
            if (end) {
                return done();
            }
        });

        parser.end(Buffer.from(message));
    });
});

describe('DKIM MessageParser edge cases', () => {
    let parse = chunks =>
        new Promise((resolve, reject) => {
            let parser = new MessageParser();
            let headers = null;
            let body = [];
            parser.on('headers', data => {
                headers = data;
            });
            parser.on('data', chunk => body.push(chunk));
            parser.on('end', () => resolve({ headers, body: Buffer.concat(body) }));
            parser.on('error', reject);
            for (let chunk of chunks) {
                parser.write(chunk);
            }
            parser.end();
        });

    it('should unfold a run of continuation lines into a single header', async () => {
        const result = await parse(['To: a@example.com,\r\n b@example.com,\r\n\tc@example.com\r\nSubject: x\r\n\r\n']);
        assert.deepStrictEqual(result.headers, [
            { key: 'to', line: 'To: a@example.com,\n b@example.com,\n\tc@example.com' },
            { key: 'subject', line: 'Subject: x' }
        ]);
    });

    it('should keep a leading continuation line on its own', async () => {
        // there is no preceding header to fold it into, so it stays a line of its own
        const result = await parse([' orphan\r\nSubject: x\r\n\r\n']);
        assert.deepStrictEqual(result.headers, [
            { key: '', line: ' orphan' },
            { key: 'subject', line: 'Subject: x' }
        ]);
    });

    // Unfolding merged each continuation line into the preceding one and then re-tested the
    // anchored /^\s/ against the merged line, which re-flattens a string that grows with
    // every continuation line. A header folded into many lines, most naturally a large
    // recipient list, made signing quadratic: 100k continuation lines took ~8.8s of blocked
    // event loop (GHSA-39m8-27wv-hr27). The budget is far above the linear cost (~20ms) and
    // far below the quadratic one, so it only trips if the unfold regresses.
    it('should unfold a deeply folded header in linear time', async () => {
        const count = 100000;
        const message =
            'From: a@example.com\r\nTo: x@example.com,\r\n' + ' cont-0000@example.com,\r\n'.repeat(count) + 'Subject: x\r\n\r\nbody';

        const started = Date.now();
        const result = await parse([Buffer.from(message, 'binary')]);
        const elapsed = Date.now() - started;

        assert.strictEqual(result.headers.length, 3);
        assert.strictEqual(result.headers[1].key, 'to');
        // the whole folded run collapsed into the single To line
        assert.strictEqual(result.headers[1].line.split('\n').length, count + 1);
        assert.strictEqual(result.body.toString(), 'body');
        assert.ok(elapsed < 5000, `unfolding ${count} continuation lines took ${elapsed}ms`);
    });
});
