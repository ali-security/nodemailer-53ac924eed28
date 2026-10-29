'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const util = require('util');
const nodemailer = require('../../lib/nodemailer');

const message = () => ({
    from: 'sender@example.com',
    to: 'recipient@example.com',
    subject: 'Test',
    text: 'Hello'
});

// bunyan compatible logger that keeps every formatted line
const captureLogger = () => {
    const lines = [];
    const logger = {};
    ['trace', 'debug', 'info', 'warn', 'error', 'fatal'].forEach(level => {
        logger[level] = (entry, format, ...args) => {
            lines.push({ level, entry, message: util.format(format, ...args) });
        };
    });
    return { lines, logger };
};

// wraps the value in arrays far deeper than a recursive walk can follow
const nest = value => {
    for (let i = 0; i < 100000; i++) {
        value = [value];
    }
    return value;
};

describe('Mail', () => {
    describe('#sendMail', () => {
        it('should deliver a recipient list nested deeper than the call stack allows', (t, done) => {
            const transporter = nodemailer.createTransport({ jsonTransport: true });
            let to = 'nested@example.com';
            for (let i = 0; i < 100000; i++) {
                to = [to];
            }

            const data = message();
            data.to = to;

            transporter.sendMail(data, (err, info) => {
                assert.ok(!err);
                assert.deepStrictEqual(info.envelope.to, ['nested@example.com']);
                assert.deepStrictEqual(JSON.parse(info.message).to, [{ address: 'nested@example.com', name: '' }]);
                done();
            });
        });

        it('should deliver deeply nested cc and bcc recipients', (t, done) => {
            const transporter = nodemailer.createTransport({ jsonTransport: true });

            const data = message();
            data.cc = nest('cc@example.com');
            data.bcc = nest(['bcc1@example.com', nest('bcc2@example.com')]);

            transporter.sendMail(data, (err, info) => {
                assert.ok(!err);
                assert.deepStrictEqual(info.envelope.to, ['recipient@example.com', 'cc@example.com', 'bcc1@example.com', 'bcc2@example.com']);
                done();
            });
        });

        it('should resolve a deeply nested explicit envelope', (t, done) => {
            // reads the compiled envelope the same way the SMTP transports do
            const transporter = nodemailer.createTransport({
                name: 'envelope-test',
                version: '1.0.0',
                send(mail, callback) {
                    callback(null, { envelope: mail.message.getEnvelope() });
                }
            });

            const data = message();
            data.envelope = {
                from: nest('bounce@example.com'),
                to: nest(['envelope1@example.com', nest('envelope2@example.com')])
            };

            transporter.sendMail(data, (err, info) => {
                assert.ok(!err);
                assert.strictEqual(info.envelope.from, 'bounce@example.com');
                assert.deepStrictEqual(info.envelope.to, ['envelope1@example.com', 'envelope2@example.com']);
                done();
            });
        });

        it('should hand an error thrown while compiling the message to the callback', (t, done) => {
            const { lines, logger } = captureLogger();
            const transporter = nodemailer.createTransport({ jsonTransport: true, logger });
            const error = new Error('no address here');
            // stringified on the way into the envelope, and the throw used to escape sendMail
            const to = {
                toString() {
                    throw error;
                }
            };

            const data = message();
            data.to = to;

            transporter.sendMail(data, err => {
                assert.strictEqual(err, error);
                const line = lines.find(line => line.level === 'error');
                assert.ok(line);
                assert.strictEqual(line.message, 'Compile Error: no address here');
                done();
            });
        });

        it('should hand an address parsing error to the callback when the message id is set', (t, done) => {
            const transporter = nodemailer.createTransport({ jsonTransport: true });
            const error = new Error('no address here');
            const to = {
                toString() {
                    throw error;
                }
            };

            const data = message();
            data.to = to;
            // with a message id the compile step does not need the envelope on its own
            data.messageId = '<test@example.com>';

            transporter.sendMail(data, err => {
                assert.strictEqual(err, error);
                done();
            });
        });

        it('should reject the promise for an error thrown while compiling the message', async () => {
            const transporter = nodemailer.createTransport({ jsonTransport: true });
            const data = message();
            // a JSON body can shadow toString, the parser then fails on the value
            data.to = JSON.parse('{"toString": "x"}');

            await assert.rejects(transporter.sendMail(data), TypeError);
        });
    });
});
