'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const MailMessage = require('../../lib/mailer/mail-message');
const nodemailer = require('../../lib/nodemailer');

describe('MailMessage Tests', () => {
    describe('constructor', () => {
        it('should not let message data reopen an access flag set in the defaults', () => {
            // `defaults` is the only channel a transporter plugin has for the sandbox, and the
            // defaults copy leaves a key alone when the message already set one
            const mailer = { options: {}, _defaults: { disableFileAccess: true, disableUrlAccess: true } };
            const message = new MailMessage(mailer, { disableFileAccess: false, disableUrlAccess: false });

            assert.strictEqual(message.data.disableFileAccess, true);
            assert.strictEqual(message.data.disableUrlAccess, true);
        });

        it('should still let message data set an access flag the configuration does not name', () => {
            const mailer = { options: {}, _defaults: {} };
            const message = new MailMessage(mailer, { disableFileAccess: true });

            assert.strictEqual(message.data.disableFileAccess, true);
        });

        it('should not let a falsy default cancel an access flag the message set', () => {
            // `defaults` built programmatically, e.g. { disableFileAccess: !!cfg.sandbox }, must
            // not switch off a message that tightened for its own untrusted content
            const mailer = { options: {}, _defaults: { disableFileAccess: false, disableUrlAccess: undefined } };
            const message = new MailMessage(mailer, { disableFileAccess: true, disableUrlAccess: true });

            assert.strictEqual(message.data.disableFileAccess, true);
            assert.strictEqual(message.data.disableUrlAccess, true);
        });

        it('should let transporter options override an access flag from the defaults', () => {
            const mailer = { options: { disableFileAccess: false }, _defaults: { disableFileAccess: true } };
            const message = new MailMessage(mailer, {});

            assert.strictEqual(message.data.disableFileAccess, false);
        });
    });

    describe('resolveContent', () => {
        // the transporter level access policy lives on the message, not on the call
        const sandboxed = data => new MailMessage({ options: { disableFileAccess: true, disableUrlAccess: true }, _defaults: {} }, data);
        const open = data => new MailMessage({ options: {}, _defaults: {} }, data);

        it('should reject a file path for the legacy callback signature', (t, done) => {
            const message = sandboxed({ html: { path: __filename } });

            message.resolveContent(message.data, 'html', err => {
                assert.strictEqual(err.code, 'EFILEACCESS');
                done();
            });
        });

        it('should reject an url for the legacy callback signature', (t, done) => {
            const message = sandboxed({ attachments: [{ filename: 'x.bin', href: 'http://127.0.0.1:1/poc' }] });

            message.resolveContent(message.data.attachments, 0, err => {
                assert.strictEqual(err.code, 'EURLACCESS');
                done();
            });
        });

        it('should apply the policy for the full (data, key, options, callback) signature', (t, done) => {
            // a path that looks like an url resolves through the url branch, so the merged
            // disableUrlAccess has to reach it from an explicit options object too
            const message = sandboxed({ html: { path: 'http://127.0.0.1:1/poc' } });

            message.resolveContent(message.data, 'html', {}, err => {
                assert.strictEqual(err.code, 'EURLACCESS');
                done();
            });
        });

        it('should reject a file path for the promise signature', async () => {
            const message = sandboxed({ html: { path: __filename } });

            await assert.rejects(message.resolveContent(message.data, 'html'), { code: 'EFILEACCESS' });
        });

        it('should let explicit options tighten the policy', async () => {
            const message = open({ html: { path: __filename } });

            await assert.rejects(message.resolveContent(message.data, 'html', { disableFileAccess: true }), { code: 'EFILEACCESS' });
        });

        it('should not let explicit options reopen the policy', async () => {
            const message = sandboxed({ html: { path: __filename } });

            await assert.rejects(message.resolveContent(message.data, 'html', { disableFileAccess: false, disableUrlAccess: false }), {
                code: 'EFILEACCESS'
            });
        });

        it('should resolve a file path when the policy allows it', (t, done) => {
            const message = open({ html: { path: __filename } });

            message.resolveContent(message.data, 'html', (err, value) => {
                assert.ok(!err);
                assert.ok(value.toString().includes('should resolve a file path when the policy allows it'));
                done();
            });
        });

        it('should resolve inline content while the policy is set', (t, done) => {
            const message = sandboxed({ html: 'hello' });

            message.resolveContent(message.data, 'html', (err, value) => {
                assert.ok(!err);
                assert.strictEqual(value, 'hello');
                done();
            });
        });

        it('should keep the sandbox when the policy came from the transporter defaults', (t, done) => {
            // createTransport leaves `options` undefined for a transporter plugin, so a policy
            // set through its second argument has to survive hostile message data
            const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true }, { disableFileAccess: true });
            const hostile = JSON.parse('{"from":"a@example.com","to":"b@example.com","text":"hi","disableFileAccess":false}');
            hostile.attachments = [{ filename: 'x', path: __filename }];

            transporter.sendMail(hostile, (err, info) => {
                // the attachment is streamed by MimeNode, which rejects the file without an error code
                assert.ok(err);
                assert.ok(!info);
                assert.match(err.message, /File access rejected/);
                done();
            });
        });

        it('should apply the policy to a compile plugin resolving during sendMail', (t, done) => {
            // how the bypass was reached in practice, a plugin resolving message content
            // on a transporter that closed file access
            const transporter = nodemailer.createTransport({ streamTransport: true, disableFileAccess: true });

            let pluginErr;
            transporter.use('compile', (mail, next) => {
                mail.resolveContent(mail.data, 'html', err => {
                    pluginErr = err;
                    next();
                });
            });

            transporter.sendMail({ from: 'a@example.com', to: 'b@example.com', text: 'hello', html: { path: __filename } }, () => {
                assert.strictEqual(pluginErr.code, 'EFILEACCESS');
                done();
            });
        });
    });
});
