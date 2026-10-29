'use strict';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const fs = require('node:fs');
const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const SMTPConnection = require('../../lib/smtp-connection');
const packageData = require('../../package.json');
const SMTPServer = require('smtp-server').SMTPServer;
const HttpConnectProxy = require('proxy-test-server');
const xoauth2Server = require('./xoauth2-mock-server');
const XOAuth2 = require('../../lib/xoauth2');

let PORT_NUMBER = 8397;
let PROXY_PORT_NUMBER = 9999;
let LMTP_PORT_NUMBER = 8396;
let XOAUTH_PORT = 8497;

describe('SMTP-Connection Tests', () => {
    describe('Version test', () => {
        it('Should expose version number', () => {
            let client = new SMTPConnection();
            assert.strictEqual(client.version, packageData.version);
        });
    });

    describe('Security', () => {
        it('should sanitize CRLF in name option to prevent SMTP injection', () => {
            let raw = 'legit.host\r\nMAIL FROM:<attacker@evil.com>\r\nRCPT TO:<victim@target.com>';
            assert.strictEqual(new SMTPConnection({ name: raw }).name, raw.replace(/[\r\n]+/g, ''));
        });

        it('should sanitize bare CR, bare LF, and runs of CRLF in name option', () => {
            assert.strictEqual(new SMTPConnection({ name: 'a\rb' }).name, 'ab');
            assert.strictEqual(new SMTPConnection({ name: 'a\nb' }).name, 'ab');
            assert.strictEqual(new SMTPConnection({ name: 'a\r\n\r\nb' }).name, 'ab');
        });

        it('should preserve a clean name option unchanged', () => {
            assert.strictEqual(new SMTPConnection({ name: 'mail.example.com' }).name, 'mail.example.com');
        });

        it('should not allow injected SMTP commands to reach the server via name option', (t, done) => {
            let receivedLines = [];
            let server = net.createServer(socket => {
                let buffer = '';
                socket.write('220 test ESMTP\r\n');
                socket.on('data', chunk => {
                    buffer += chunk.toString();
                    let idx;
                    while ((idx = buffer.indexOf('\r\n')) !== -1) {
                        let line = buffer.slice(0, idx);
                        buffer = buffer.slice(idx + 2);
                        receivedLines.push(line);
                        if (/^EHLO\b/i.test(line) || /^HELO\b/i.test(line)) {
                            socket.write('250 OK\r\n');
                        } else if (/^QUIT\b/i.test(line)) {
                            socket.write('221 Bye\r\n');
                            socket.end();
                        }
                    }
                });
            });

            server.listen(0, '127.0.0.1', () => {
                let port = server.address().port;
                let client = new SMTPConnection({
                    port,
                    host: '127.0.0.1',
                    ignoreTLS: true,
                    logger: false,
                    name: 'legit.host\r\nMAIL FROM:<attacker@evil.com>\r\nRCPT TO:<victim@target.com>\r\nDATA\r\nphishing\r\n.'
                });

                client.on('error', err => {
                    server.close();
                    done(err);
                });

                client.connect(() => {
                    client.quit();
                });

                client.on('end', () => {
                    server.close(() => {
                        let ehloLines = receivedLines.filter(line => /^EHLO\b/i.test(line));
                        let injectedLines = receivedLines.filter(line => /^(MAIL FROM|RCPT TO|DATA)\b/i.test(line));
                        assert.strictEqual(ehloLines.length, 1, 'expected exactly one EHLO command');
                        assert.strictEqual(injectedLines.length, 0, 'no injected SMTP commands should reach the server');
                        assert.ok(!/[\r\n]/.test(ehloLines[0]));
                        done();
                    });
                });
            });
        });
    });

    describe('Multiline response reassembly', () => {
        // A connection that is never wired to a socket, with an action queue that keeps
        // collecting whatever completed replies the parser hands over
        function feedingConnection(options) {
            const conn = new SMTPConnection(Object.assign({ logger: false }, options));
            const received = [];
            const errors = [];
            conn.on('error', err => errors.push(err));
            const collect = str => {
                received.push(str);
                conn._responseActions.push(collect);
            };
            conn._responseActions = [collect];
            return { conn, received, errors };
        }

        it('joins the continuation lines of a reply split across chunks', () => {
            const { conn, received, errors } = feedingConnection();
            // one byte at a time, so the partial state has to survive every _onData call
            for (const chr of '250-first\r\n250-second\r\n250 third\r\n') {
                conn._onData(Buffer.from(chr, 'binary'));
            }
            conn.close();
            assert.deepStrictEqual(errors, []);
            assert.deepStrictEqual(received, ['250-first\n250-second\n250 third']);
        });

        it('keeps consecutive replies in one chunk apart', async () => {
            const { conn, received, errors } = feedingConnection();
            conn._onData(Buffer.from('220 greeting\r\n250-first\r\n250 second\r\n250 third\r\n', 'binary'));
            // the queue is drained one reply per tick
            await new Promise(resolve => setTimeout(resolve, 50));
            conn.close();
            assert.deepStrictEqual(errors, []);
            assert.deepStrictEqual(received, ['220 greeting', '250-first\n250 second', '250 third']);
        });

        // Every continuation line was appended to the queue entry and the entry was then
        // re-scanned to find its last line, which re-flattens a string that grows with the
        // reply. A hostile peer streaming continuation lines drove the reassembly quadratic
        // before the client ever authenticated: 128k lines took ~15s of blocked event loop
        // (GHSA-4g23-2xm8-66gc). The budget is far above the linear cost (~10ms) and far
        // below the quadratic one, so it only trips if the reassembly regresses.
        it('reassembles a very long reply in linear time', () => {
            const count = 128000;
            // the cap is raised so this measures the reassembly and not the size guard
            const { conn, received, errors } = feedingConnection({ maxResponseSize: 100 * 1024 * 1024 });

            let payload = '';
            for (let i = 0; i < count; i++) {
                payload += '250-capability line ' + i + '\r\n';
            }
            payload += '250 DONE\r\n';

            const started = Date.now();
            conn._onData(Buffer.from(payload, 'binary'));
            const elapsed = Date.now() - started;
            conn.close();

            assert.deepStrictEqual(errors, []);
            assert.strictEqual(received.length, 1);
            assert.strictEqual(received[0].split('\n').length, count + 1);
            assert.ok(elapsed < 5000, `reassembling ${count} continuation lines took ${elapsed}ms`);
        });

        it('fails the connection when a reply never completes', () => {
            const { conn, received, errors } = feedingConnection({ maxResponseSize: 16 * 1024 });
            // a peer that keeps the reply open forever would otherwise buffer without bound
            for (let i = 0; i < 40; i++) {
                conn._onData(Buffer.from('220-flood line padded out to a few hundred bytes '.repeat(10) + '\r\n', 'binary'));
            }
            assert.deepStrictEqual(received, []);
            assert.strictEqual(errors.length, 1);
            assert.strictEqual(errors[0].code, 'EPROTOCOL');
            assert.match(errors[0].message, /exceeds maximum allowed size/);
        });

        it('fails the connection when a single line never ends', () => {
            const { conn, errors } = feedingConnection({ maxResponseSize: 16 * 1024 });
            // no line break at all, so the bytes pile up in the remainder instead
            for (let i = 0; i < 40; i++) {
                conn._onData(Buffer.from('x'.repeat(1024), 'binary'));
            }
            assert.strictEqual(errors.length, 1);
            assert.strictEqual(errors[0].code, 'EPROTOCOL');
        });

        // The cap bounds one reply, so a connection that keeps receiving replies just under
        // it must stay up however many of them arrive
        it('does not accumulate separate replies towards the cap', async () => {
            const { conn, received, errors } = feedingConnection({ maxResponseSize: 16 * 1024 });
            const reply = '250-capability line padded out to some length\r\n'.repeat(300) + '250 DONE\r\n';
            assert.ok(reply.length > 8 * 1024 && reply.length < 16 * 1024, 'the reply has to sit just under the cap');
            for (let i = 0; i < 5; i++) {
                conn._onData(Buffer.from(reply, 'binary'));
            }
            await new Promise(resolve => setTimeout(resolve, 50));
            conn.close();
            assert.deepStrictEqual(errors, []);
            assert.strictEqual(received.length, 5);
        });

        // The guard used to be applied once per chunk and after the completed reply had
        // already been forgotten, so whether an oversized reply was caught depended on how
        // the peer happened to split it into TCP segments
        it('applies the cap the same way however the reply is split', () => {
            const oversized = '250-capability line padded out to some length\r\n'.repeat(600) + '250 DONE\r\n';
            assert.ok(oversized.length > 16 * 1024, 'the reply has to exceed the cap');

            const whole = feedingConnection({ maxResponseSize: 16 * 1024 });
            whole.conn._onData(Buffer.from(oversized, 'binary'));

            const split = feedingConnection({ maxResponseSize: 16 * 1024 });
            for (let pos = 0; pos < oversized.length; pos += 500) {
                split.conn._onData(Buffer.from(oversized.slice(pos, pos + 500), 'binary'));
            }

            for (const { received, errors } of [whole, split]) {
                assert.deepStrictEqual(received, []);
                assert.strictEqual(errors.length, 1);
                assert.strictEqual(errors[0].code, 'EPROTOCOL');
            }
        });

        // The remainder holds the line currently being received, and it used to be re-split
        // together with every new chunk, rescanning everything buffered so far. A peer that
        // drip-fed a line that never ends made that quadratic even with the cap in place:
        // 1 MB in one byte chunks took ~60s of blocked event loop.
        it('absorbs a line that never ends in linear time', () => {
            const { conn, errors } = feedingConnection({ maxResponseSize: 1024 * 1024 });

            const started = Date.now();
            // one byte at a time, the worst case for re-splitting the remainder
            for (let i = 0; i < 1024 * 1024 + 16; i++) {
                conn._onData(Buffer.from('x', 'binary'));
            }
            const elapsed = Date.now() - started;

            assert.strictEqual(errors.length, 1);
            assert.strictEqual(errors[0].code, 'EPROTOCOL');
            assert.ok(elapsed < 5000, `absorbing 1MB one byte at a time took ${elapsed}ms`);
        });
    });

    describe('Connection tests', () => {
        let server, insecureServer, invalidServer, secureServer, disconnectingServer, httpProxy;

        before((t, done) => {
            server = new SMTPServer({
                onAuth: (auth, session, callback) => {
                    if (auth.username !== 'testuser' || auth.password !== 'testpass') {
                        return callback(new Error('Invalid username or password'));
                    }
                    callback(null, {
                        user: auth.username
                    });
                },
                onData: (stream, session, callback) => {
                    stream.on('data', () => {});
                    stream.on('end', callback);
                }
            });

            insecureServer = new SMTPServer({
                disabledCommands: ['STARTTLS', 'AUTH'],
                onData: (stream, session, callback) => {
                    let err = false;
                    stream.on('data', chunk => {
                        if (err || session.use8BitMime) {
                            return;
                        }
                        for (let i = 0, len = chunk.length; i < len; i++) {
                            if (chunk[i] >= 0x80) {
                                err = new Error('8 bit content not allowed');
                            }
                        }
                    });
                    stream.on('end', () => {
                        callback(err, false);
                    });
                },
                logger: false
            });

            invalidServer = net.createServer(() => {});

            secureServer = new SMTPServer({
                secure: true,
                onAuth: (auth, session, callback) => {
                    if (auth.username !== 'testuser' || auth.password !== 'testpass') {
                        return callback(new Error('Invalid username or password'));
                    }
                    callback(null, {
                        user: auth.username
                    });
                },
                onData: (stream, session, callback) => {
                    stream.on('data', () => {});
                    stream.on('end', callback);
                },
                logger: false
            });

            disconnectingServer = new SMTPServer({
                disabledCommands: ['STARTTLS', 'AUTH'],
                onConnect(sess, callback) {
                    setTimeout(() => {
                        for (const conn of this.connections) {
                            conn._socket.write('454 4.3.0 Try again later\r\n');
                            conn._socket.destroy();
                        }
                    }, 20);
                    callback();
                },
                logger: false
            });

            httpProxy = new HttpConnectProxy();

            server.listen(PORT_NUMBER, () => {
                invalidServer.listen(PORT_NUMBER + 1, () => {
                    secureServer.listen(PORT_NUMBER + 2, () => {
                        insecureServer.listen(PORT_NUMBER + 3, () => {
                            disconnectingServer.listen(PORT_NUMBER + 4, () => {
                                httpProxy.listen(PROXY_PORT_NUMBER, done);
                            });
                        });
                    });
                });
            });
        });

        after((t, done) => {
            server.close(() => {
                invalidServer.close(() => {
                    secureServer.close(() => {
                        insecureServer.close(() => {
                            disconnectingServer.close(() => {
                                httpProxy.close(done);
                            });
                        });
                    });
                });
            });
        });

        it('should connect to unsecure server', (t, done) => {
            let client = new SMTPConnection({
                port: PORT_NUMBER + 3,
                ignoreTLS: true,
                logger: false
            });

            client.connect(() => {
                assert.strictEqual(client.secure, false);
                client.close();
            });

            client.on('error', err => {
                assert.ok(!err);
            });

            client.on('end', done);
        });

        it('should connect to a server and upgrade with STARTTLS', (t, done) => {
            let client = new SMTPConnection({
                port: PORT_NUMBER,
                logger: false
            });

            client.connect(() => {
                assert.strictEqual(client.secure, true);
                client.close();
            });

            client.on('error', err => {
                assert.ok(!err);
            });

            client.on('end', done);
        });

        it('should connect and be rejected', (t, done) => {
            let client = new SMTPConnection({
                port: PORT_NUMBER + 4,
                logger: false,
                debug: false,
                transactionLog: false
            });

            client.connect(() => {
                assert.strictEqual(client.secure, false);
            });

            client.on('error', err => {
                assert.ok(err);
            });

            client.on('end', done);
        });

        it('should connect to a server and upgrade with forced STARTTLS', (t, done) => {
            let client = new SMTPConnection({
                port: PORT_NUMBER,
                requireTLS: true,
                transactionLog: true,
                logger: false
            });

            client.connect(() => {
                assert.strictEqual(client.secure, true);
                client.close();
            });

            client.on('error', err => {
                assert.ok(!err);
            });

            client.on('end', done);
        });

        it('should connect to a server and try to upgrade STARTTLS', (t, done) => {
            let client = new SMTPConnection({
                port: PORT_NUMBER + 3,
                logger: false,
                requireTLS: true,
                opportunisticTLS: true
            });

            client.connect(() => {
                assert.strictEqual(client.secure, false);
                client.close();
            });

            client.on('error', err => {
                assert.ok(!err);
            });

            client.on('end', done);
        });

        it('should try upgrade with STARTTLS where not advertised', (t, done) => {
            let client = new SMTPConnection({
                port: PORT_NUMBER + 3,
                requireTLS: true,
                logger: false
            });

            client.connect(() => {
                // should not run
                assert.strictEqual(false, true);
                client.close();
            });

            client.once('error', err => {
                assert.ok(err);
            });

            client.on('end', done);
        });

        it('should close connection after STARTTLS', (t, done) => {
            let client = new SMTPConnection({
                port: PORT_NUMBER,
                logger: false
            });

            client.connect(() => {
                assert.strictEqual(client.secure, true);
                server.connections.forEach(conn => {
                    conn.close();
                });
            });

            client.on('error', err => {
                assert.strictEqual(err.message, 'Connection closed unexpectedly');
            });

            client.on('end', done);
        });

        it('should connect to a secure server', (t, done) => {
            let client = new SMTPConnection({
                port: PORT_NUMBER + 2,
                secure: true,
                logger: false
            });

            client.connect(() => {
                assert.strictEqual(client.secure, true);
                client.close();
            });

            client.on('error', err => {
                assert.ok(!err);
            });

            client.on('end', done);
        });

        it('should emit error for invalid port', (t, done) => {
            let client = new SMTPConnection({
                port: PORT_NUMBER + 10,
                logger: false
            });

            client.connect(() => {
                // should not run
                assert.strictEqual(false, true);
                client.close();
            });

            client.once('error', err => {
                assert.ok(err);
            });

            client.on('end', done);
        });

        it('should emit error for too large port', (t, done) => {
            let client = new SMTPConnection({
                port: 999999999,
                logger: false
            });

            client.connect(() => {
                // should not run
                assert.strictEqual(false, true);
                client.close();
            });

            client.once('error', err => {
                assert.ok(err);
            });

            client.on('end', done);
        });

        it('should emit inactivity timeout error', (t, done) => {
            let client = new SMTPConnection({
                port: PORT_NUMBER,
                socketTimeout: 100,
                logger: false
            });

            client.connect(() => {
                // do nothing
            });

            client.once('error', err => {
                assert.ok(err);
                assert.strictEqual(err.code, 'ETIMEDOUT');
            });

            client.on('end', done);
        });

        it('should connect through proxy', (t, done) => {
            let runTest = function (socket) {
                let client = new SMTPConnection({
                    logger: false,
                    port: PORT_NUMBER,
                    connection: socket
                });

                client.connect(() => {
                    assert.strictEqual(client.secure, true);
                    client.login(
                        {
                            user: 'testuser',
                            credentials: {
                                user: 'testuser',
                                pass: 'testpass'
                            }
                        },
                        err => {
                            assert.ok(!err);
                            assert.strictEqual(client.authenticated, true);
                            client.close();
                        }
                    );
                });

                client.on('error', err => {
                    assert.ok(!err);
                });

                client.on('end', done);
            };

            proxyConnect(PROXY_PORT_NUMBER, '127.0.0.1', PORT_NUMBER, '127.0.0.1', (err, socket) => {
                assert.ok(!err);
                runTest(socket);
            });
        });

        it('should connect through proxy to secure server', (t, done) => {
            let runTest = function (socket) {
                let client = new SMTPConnection({
                    logger: false,
                    port: PORT_NUMBER + 2,
                    secure: true,
                    connection: socket
                });

                client.connect(() => {
                    assert.strictEqual(client.secure, true);
                    client.login(
                        {
                            user: 'testuser',
                            credentials: {
                                user: 'testuser',
                                pass: 'testpass'
                            }
                        },
                        err => {
                            assert.ok(!err);
                            assert.strictEqual(client.authenticated, true);
                            client.close();
                        }
                    );
                });

                client.on('error', err => {
                    assert.ok(!err);
                });

                client.on('end', done);
            };

            proxyConnect(PROXY_PORT_NUMBER, '127.0.0.1', PORT_NUMBER + 2, '127.0.0.1', (err, socket) => {
                assert.ok(!err);
                runTest(socket);
            });
        });

        it('should send to unsecure server', (t, done) => {
            let client = new SMTPConnection({
                port: PORT_NUMBER + 3,
                ignoreTLS: true,
                logger: true,
                debug: true
            });

            client.on('error', err => {
                assert.ok(!err);
            });

            client.connect(() => {
                assert.strictEqual(client.secure, false);

                let chunks = [],
                    fname = __dirname + '/../../LICENSE',
                    message = fs.readFileSync(fname, 'utf-8');

                server.on('data', (connection, chunk) => {
                    chunks.push(chunk);
                });

                server.removeAllListeners('dataReady');
                server.on('dataReady', (connection, callback) => {
                    let body = Buffer.concat(chunks);
                    assert.strictEqual(body.toString(), message.toString().trim().replace(/\n/g, '\r\n'));
                    callback(null, 'ABC1');
                });

                client.send(
                    {
                        from: 'test@valid.sender',
                        to: 'test@valid.recipient'
                    },
                    fs.createReadStream(fname),
                    err => {
                        assert.ok(!err);
                        client.close();
                    }
                );
            });

            client.on('end', done);
        });
    });

    describe('Login tests', () => {
        let server,
            lmtpServer,
            client,
            lmtpClient,
            testtoken = 'testtoken';

        beforeEach((t, done) => {
            server = new SMTPServer({
                authMethods: ['PLAIN', 'XOAUTH2'],
                disabledCommands: ['STARTTLS'],

                size: 100 * 1024,

                onData: (stream, session, callback) => {
                    let err = false;
                    stream.on('data', chunk => {
                        if (err || session.use8BitMime) {
                            return;
                        }
                        for (let i = 0, len = chunk.length; i < len; i++) {
                            if (chunk[i] >= 0x80) {
                                err = new Error('8 bit content not allowed');
                            }
                        }
                    });
                    stream.on('end', () => {
                        callback(err, false);
                    });
                },

                onAuth: (auth, session, callback) => {
                    if (auth.method !== 'XOAUTH2') {
                        if (auth.username !== 'testuser' || auth.password !== 'testpass') {
                            return callback(new Error('Invalid username or password'));
                        }
                    } else if (auth.username !== 'testuser' || auth.accessToken !== testtoken) {
                        return callback(null, {
                            data: {
                                status: '401',
                                schemes: 'bearer mac',
                                scope: 'my_smtp_access_scope_name'
                            }
                        });
                    }
                    callback(null, {
                        user: auth.username
                    });
                },
                onMailFrom: (address, session, callback) => {
                    if (address.args && parseInt(address.args.SIZE, 10) > 50 * 1024) {
                        return callback(new Error('452 Insufficient channel storage: ' + address.address));
                    }

                    if (!/@valid.sender/.test(address.address)) {
                        return callback(new Error('Only user@valid.sender is allowed to send mail'));
                    }

                    if (address.args.SMTPUTF8) {
                        session.smtpUtf8 = true;
                    }

                    if (address.args.BODY === '8BITMIME') {
                        session.use8BitMime = true;
                    }

                    if (/[\x80-\uFFFF]/.test(address.address) && !session.smtpUtf8) {
                        return callback(new Error('Trying to use Unicode address without declaring SMTPUTF8 first'));
                    }

                    return callback(); // Accept the address
                },
                onRcptTo: (address, session, callback) => {
                    if (!/@valid.recipient/.test(address.address)) {
                        return callback(new Error('Only user@valid.recipient is allowed to receive mail'));
                    }
                    if (/[\x80-\uFFFF]/.test(address.address) && !session.smtpUtf8) {
                        return callback(new Error('Trying to use Unicode address without declaring SMTPUTF8 first'));
                    }
                    return callback(); // Accept the address
                },
                logger: false
            });

            lmtpServer = new SMTPServer({
                lmtp: true,
                disabledCommands: ['STARTTLS', 'AUTH'],

                onData: (stream, session, callback) => {
                    stream.on('data', () => {});
                    stream.on('end', () => {
                        let response = session.envelope.rcptTo.map((rcpt, i) => {
                            if (i % 2) {
                                return '<' + rcpt.address + '> Accepted';
                            } else {
                                return new Error('<' + rcpt.address + '> Not accepted');
                            }
                        });
                        callback(null, response);
                    });
                },
                onMailFrom: (address, session, callback) => {
                    if (!/@valid.sender/.test(address.address)) {
                        return callback(new Error('Only user@valid.sender is allowed to send mail'));
                    }
                    return callback(); // Accept the address
                },
                onRcptTo: (address, session, callback) => {
                    if (!/@valid.recipient/.test(address.address)) {
                        return callback(new Error('Only user@valid.recipient is allowed to receive mail'));
                    }
                    return callback(); // Accept the address
                },
                logger: false
            });

            client = new SMTPConnection({
                port: PORT_NUMBER,
                logger: false,
                debug: false
            });

            lmtpClient = new SMTPConnection({
                port: LMTP_PORT_NUMBER,
                lmtp: true,
                logger: false,
                debug: false
            });

            server.listen(PORT_NUMBER, () => {
                lmtpServer.listen(LMTP_PORT_NUMBER, () => {
                    client.connect(() => {
                        lmtpClient.connect(done);
                    });
                });
            });
        });

        afterEach((t, done) => {
            client.close();
            lmtpClient.close();
            server.close(() => {
                lmtpServer.close(done);
            });
        });

        it('should login', (t, done) => {
            assert.strictEqual(client.authenticated, false);
            client.login(
                {
                    user: 'testuser',
                    credentials: {
                        user: 'testuser',
                        pass: 'testpass'
                    }
                },
                err => {
                    assert.ok(!err);
                    assert.strictEqual(client.authenticated, true);
                    done();
                }
            );
        });

        it('should return error for invalid login', (t, done) => {
            assert.strictEqual(client.authenticated, false);
            client.login(
                {
                    user: 'testuser',
                    credentials: {
                        user: 'testuser',
                        pass: 'invalid'
                    }
                },
                err => {
                    assert.ok(err);
                    assert.strictEqual(client.authenticated, false);
                    assert.strictEqual(err.code, 'EAUTH');
                    assert.strictEqual(err.responseCode, 535);
                    done();
                }
            );
        });

        it('should return error for missing credentials', (t, done) => {
            assert.strictEqual(client.authenticated, false);
            client.login(
                {
                    user: 'testuser'
                },
                err => {
                    assert.ok(err);
                    assert.strictEqual(client.authenticated, false);
                    assert.ok(/^Missing credentials/.test(err.message));
                    assert.strictEqual(err.code, 'EAUTH');
                    assert.strictEqual(err.response, undefined);
                    done();
                }
            );
        });

        it('should return error for incomplete credentials', (t, done) => {
            assert.strictEqual(client.authenticated, false);
            client.login(
                {
                    user: 'testuser',
                    credentials: {
                        user: 'testuser'
                    }
                },
                err => {
                    assert.ok(err);
                    assert.strictEqual(client.authenticated, false);
                    assert.ok(/^Missing credentials/.test(err.message));
                    assert.strictEqual(err.code, 'EAUTH');
                    assert.strictEqual(err.response, undefined);
                    done();
                }
            );
        });

        describe('xoauth2 login', () => {
            let x2server;

            beforeEach((t, done) => {
                x2server = xoauth2Server({
                    port: XOAUTH_PORT,
                    onUpdate: (username, accessToken) => {
                        testtoken = accessToken;
                    }
                });

                x2server.addUser('testuser', 'refresh-token');

                x2server.start(done);
            });

            afterEach((t, done) => {
                x2server.stop(done);
            });

            it('should login with xoauth2 string', (t, done) => {
                assert.strictEqual(client.authenticated, false);
                client.login(
                    {
                        type: 'oauth2',
                        user: 'testuser',
                        oauth2: new XOAuth2({
                            user: 'testuser',
                            accessToken: testtoken
                        })
                    },
                    err => {
                        assert.ok(!err);
                        assert.strictEqual(client.authenticated, true);
                        done();
                    }
                );
            });

            it('should return error for invalid xoauth2 string token', (t, done) => {
                assert.strictEqual(client.authenticated, false);
                client.login(
                    {
                        type: 'oauth2',
                        user: 'testuser',
                        oauth2: new XOAuth2({
                            user: 'testuser',
                            accessToken: 'invalid'
                        })
                    },
                    err => {
                        assert.ok(err);
                        assert.strictEqual(client.authenticated, false);
                        assert.strictEqual(err.code, 'EAUTH');
                        done();
                    }
                );
            });

            it('should login with xoauth2 object', (t, done) => {
                assert.strictEqual(client.authenticated, false);
                client.login(
                    {
                        type: 'oauth2',
                        user: 'testuser',
                        oauth2: new XOAuth2({
                            user: 'testuser',
                            clientId: '{Client ID}',
                            clientSecret: '{Client Secret}',
                            refreshToken: 'refresh-token',
                            accessToken: 'uuuuu',
                            accessUrl: 'http://localhost:' + XOAUTH_PORT
                        })
                    },
                    err => {
                        assert.ok(!err);
                        assert.strictEqual(client.authenticated, true);
                        done();
                    }
                );
            });

            it('should fail with xoauth2 object', (t, done) => {
                assert.strictEqual(client.authenticated, false);
                client.login(
                    {
                        type: 'oauth2',
                        user: 'testuser',
                        oauth2: new XOAuth2({
                            user: 'testuser',
                            clientId: '{Client ID}',
                            clientSecret: '{Client Secret}',
                            refreshToken: 'refrsesh-token',
                            accessToken: 'uuuuu',
                            accessUrl: 'http://localhost:' + XOAUTH_PORT
                        })
                    },
                    err => {
                        assert.ok(err);
                        assert.strictEqual(client.authenticated, false);
                        done();
                    }
                );
            });

            it('should fail with invalid xoauth2 response', (t, done) => {
                assert.strictEqual(client.authenticated, false);

                let oauth2 = new XOAuth2({
                    user: 'testuser',
                    clientId: '{Client ID}',
                    clientSecret: '{Client Secret}',
                    refreshToken: 'refrsesh-token',
                    accessToken: 'uuuuu',
                    accessUrl: 'http://localhost:' + XOAUTH_PORT
                });

                t.mock.method(oauth2, 'generateToken', cb => cb(null, 'dXNlcj10ZXN0dXNlcgFhdXRoPUJlYXJlciB1dXV1dQEB'));

                client.login(
                    {
                        type: 'oauth2',
                        user: 'testuser',
                        oauth2
                    },
                    err => {
                        assert.ok(err);
                        assert.strictEqual(client.authenticated, false);

                        t.mock.restoreAll();
                        done();
                    }
                );
            });
        });

        describe('custom login', () => {
            let customClient;
            beforeEach((t, done) => {
                customClient = new SMTPConnection({
                    port: PORT_NUMBER,
                    logger: false,
                    debug: false,
                    customAuth: {
                        mytest: client => {
                            client.sendCommand('HALLO1 HALLO', (err, response) => {
                                assert.ok(!err);
                                assert.strictEqual(response.status, 500);
                                client.sendCommand('HALLO2 HALLO', (err, response) => {
                                    assert.ok(!err);
                                    assert.strictEqual(response.status, 500);
                                    client.resolve();
                                });
                            });
                        }
                    }
                });

                customClient.connect(done);
            });

            afterEach((t, done) => {
                customClient.close();
                done();
            });

            it('should login', (t, done) => {
                assert.strictEqual(customClient.authenticated, false);
                customClient.login(
                    {
                        method: 'mytest',
                        user: 'testuser',
                        credentials: {
                            user: 'testuser',
                            pass: 'testpass'
                        }
                    },
                    err => {
                        assert.ok(!err);
                        assert.strictEqual(customClient.authenticated, true);
                        done();
                    }
                );
            });

            it('should login without pass', (t, done) => {
                assert.strictEqual(customClient.authenticated, false);
                customClient.login(
                    {
                        method: 'mytest',
                        apiUser: 'aaaa',
                        apiKey: 'testkey'
                    },
                    err => {
                        assert.ok(!err);
                        assert.strictEqual(customClient.authenticated, true);
                        done();
                    }
                );
            });
        });

        describe('Send without PIPELINING', () => {
            beforeEach((t, done) => {
                client.on('end', () => {
                    client = new SMTPConnection({
                        port: PORT_NUMBER,
                        logger: false,
                        debug: false
                    });
                    // disable PIPELINING
                    server.options.hidePIPELINING = true;
                    client.connect(() => {
                        client.login(
                            {
                                user: 'testuser',
                                credentials: {
                                    user: 'testuser',
                                    pass: 'testpass'
                                }
                            },
                            err => {
                                assert.ok(!err);
                                // enable PIPELINING
                                server.options.hidePIPELINING = false;
                                done();
                            }
                        );
                    });
                });
                client.close();
            });

            it('should send only to valid recipients without PIPELINING', (t, done) => {
                client.send(
                    {
                        from: 'test@valid.sender',
                        to: ['test1@valid.recipient', 'test2@invalid.recipient', 'test3@valid.recipient']
                    },
                    'test',
                    (err, info) => {
                        assert.ok(!err);
                        assert.deepStrictEqual(info, {
                            accepted: ['test1@valid.recipient', 'test3@valid.recipient'],
                            rejected: ['test2@invalid.recipient'],
                            ehlo: ['8BITMIME', 'SMTPUTF8', 'AUTH PLAIN XOAUTH2', 'SIZE 102400'],
                            rejectedErrors: info.rejectedErrors,
                            envelopeTime: info.envelopeTime,
                            messageTime: info.messageTime,
                            messageSize: info.messageSize,
                            response: '250 OK: message queued'
                        });
                        assert.strictEqual(info.rejectedErrors.length, 1);
                        done();
                    }
                );
            });
        });

        describe('Send messages', () => {
            beforeEach((t, done) => {
                client.login(
                    {
                        user: 'testuser',
                        credentials: {
                            user: 'testuser',
                            pass: 'testpass'
                        }
                    },
                    err => {
                        assert.ok(!err);
                        done();
                    }
                );
            });

            it('should send message', (t, done) => {
                client.send(
                    {
                        from: 'test@valid.sender',
                        to: 'test@valid.recipient'
                    },
                    'test',
                    (err, info) => {
                        assert.ok(!err);
                        assert.deepStrictEqual(info, {
                            accepted: ['test@valid.recipient'],
                            rejected: [],
                            ehlo: ['PIPELINING', '8BITMIME', 'SMTPUTF8', 'AUTH PLAIN XOAUTH2', 'SIZE 102400'],
                            envelopeTime: info.envelopeTime,
                            messageTime: info.messageTime,
                            messageSize: info.messageSize,
                            response: '250 OK: message queued'
                        });
                        done();
                    }
                );
            });

            it('should send multiple messages', (t, done) => {
                client.send(
                    {
                        from: 'test@valid.sender',
                        to: 'test@valid.recipient'
                    },
                    'test',
                    (err, info) => {
                        assert.ok(!err);
                        assert.deepStrictEqual(info, {
                            accepted: ['test@valid.recipient'],
                            rejected: [],
                            ehlo: ['PIPELINING', '8BITMIME', 'SMTPUTF8', 'AUTH PLAIN XOAUTH2', 'SIZE 102400'],
                            envelopeTime: info.envelopeTime,
                            messageTime: info.messageTime,
                            messageSize: info.messageSize,
                            response: '250 OK: message queued'
                        });
                        client.reset(err => {
                            assert.ok(!err);

                            client.send(
                                {
                                    from: 'test2@valid.sender',
                                    to: 'test2@valid.recipient'
                                },
                                'test2',
                                (err, info) => {
                                    assert.ok(!err);
                                    assert.deepStrictEqual(info, {
                                        accepted: ['test2@valid.recipient'],
                                        rejected: [],
                                        ehlo: ['PIPELINING', '8BITMIME', 'SMTPUTF8', 'AUTH PLAIN XOAUTH2', 'SIZE 102400'],
                                        envelopeTime: info.envelopeTime,
                                        messageTime: info.messageTime,
                                        messageSize: info.messageSize,
                                        response: '250 OK: message queued'
                                    });
                                    done();
                                }
                            );
                        });
                    }
                );
            });

            it('should send only to valid recipients', (t, done) => {
                client.send(
                    {
                        from: 'test@valid.sender',
                        to: ['test1@valid.recipient', 'test2@invalid.recipient', 'test3@valid.recipient']
                    },
                    'test',
                    (err, info) => {
                        assert.ok(!err);
                        assert.deepStrictEqual(info, {
                            accepted: ['test1@valid.recipient', 'test3@valid.recipient'],
                            rejected: ['test2@invalid.recipient'],
                            ehlo: ['PIPELINING', '8BITMIME', 'SMTPUTF8', 'AUTH PLAIN XOAUTH2', 'SIZE 102400'],
                            rejectedErrors: info.rejectedErrors,
                            envelopeTime: info.envelopeTime,
                            messageTime: info.messageTime,
                            messageSize: info.messageSize,
                            response: '250 OK: message queued'
                        });
                        assert.strictEqual(info.rejectedErrors.length, 1);
                        done();
                    }
                );
            });

            it('should reject all recipients', (t, done) => {
                client.send(
                    {
                        from: 'test@valid.sender',
                        to: ['test1@invalid.recipient', 'test2@invalid.recipient', 'test3@invalid.recipient']
                    },
                    'test',
                    (err, info) => {
                        assert.ok(err);
                        assert.ok(!info);
                        assert.deepStrictEqual(err.rejected, ['test1@invalid.recipient', 'test2@invalid.recipient', 'test3@invalid.recipient']);
                        assert.strictEqual(err.rejectedErrors.length, 3);
                        done();
                    }
                );
            });

            it('should reject too large SIZE arguments', (t, done) => {
                client.send(
                    {
                        from: 'test2@valid.sender',
                        to: 'test2@valid.recipient',
                        size: 1024 * 1024
                    },
                    'test',
                    (err, info) => {
                        assert.ok(err);
                        assert.ok(!info);
                        done();
                    }
                );
            });

            it('should reject too large message', (t, done) => {
                client.send(
                    {
                        from: 'test2@valid.sender',
                        to: 'test2@valid.recipient',
                        size: 70 * 1024
                    },
                    'test',
                    (err, info) => {
                        assert.ok(err);
                        assert.ok(!info);
                        done();
                    }
                );
            });

            it('should declare SIZE', (t, done) => {
                client.send(
                    {
                        from: 'test2@valid.sender',
                        to: 'test2@valid.recipient',
                        size: 10 * 1024
                    },
                    'test',
                    (err, info) => {
                        assert.ok(!err);
                        assert.deepStrictEqual(info, {
                            accepted: ['test2@valid.recipient'],
                            rejected: [],
                            ehlo: ['PIPELINING', '8BITMIME', 'SMTPUTF8', 'AUTH PLAIN XOAUTH2', 'SIZE 102400'],
                            envelopeTime: info.envelopeTime,
                            messageTime: info.messageTime,
                            messageSize: info.messageSize,
                            response: '250 OK: message queued'
                        });
                        done();
                    }
                );
            });

            it('lmtp should send only to valid recipients', (t, done) => {
                lmtpClient.send(
                    {
                        from: 'test@valid.sender',
                        to: [
                            'test1@valid.recipient',
                            'test2@invalid.recipient',
                            'test3@valid.recipient',
                            'test4@valid.recipient',
                            'test5@valid.recipient',
                            'test6@valid.recipient'
                        ]
                    },
                    'test',
                    (err, info) => {
                        assert.ok(!err);
                        assert.deepStrictEqual(info.accepted, ['test3@valid.recipient', 'test5@valid.recipient']);
                        assert.deepStrictEqual(info.rejected, [
                            'test2@invalid.recipient',
                            'test1@valid.recipient',
                            'test4@valid.recipient',
                            'test6@valid.recipient'
                        ]);
                        assert.strictEqual(info.rejectedErrors.length, info.rejected.length);
                        done();
                    }
                );
            });

            it('should send using SMTPUTF8', (t, done) => {
                client.send(
                    {
                        from: 'test@valid.sender',
                        to: ['test1@valid.recipient', 'test2@invalid.recipient', 'test3õ@valid.recipient']
                    },
                    'test',
                    (err, info) => {
                        assert.ok(!err);
                        assert.deepStrictEqual(info, {
                            accepted: ['test1@valid.recipient', 'test3õ@valid.recipient'],
                            rejected: ['test2@invalid.recipient'],
                            ehlo: ['PIPELINING', '8BITMIME', 'SMTPUTF8', 'AUTH PLAIN XOAUTH2', 'SIZE 102400'],
                            rejectedErrors: info.rejectedErrors,
                            envelopeTime: info.envelopeTime,
                            messageTime: info.messageTime,
                            messageSize: info.messageSize,
                            response: '250 OK: message queued'
                        });
                        done();
                    }
                );
            });

            it('should send using 8BITMIME', (t, done) => {
                client.send(
                    {
                        use8BitMime: true,
                        from: 'test@valid.sender',
                        to: ['test1@valid.recipient', 'test2@invalid.recipient', 'test3õ@valid.recipient']
                    },
                    'õõõõ',
                    (err, info) => {
                        assert.ok(!err);
                        assert.deepStrictEqual(info, {
                            accepted: ['test1@valid.recipient', 'test3õ@valid.recipient'],
                            rejected: ['test2@invalid.recipient'],
                            ehlo: ['PIPELINING', '8BITMIME', 'SMTPUTF8', 'AUTH PLAIN XOAUTH2', 'SIZE 102400'],
                            rejectedErrors: info.rejectedErrors,
                            envelopeTime: info.envelopeTime,
                            messageTime: info.messageTime,
                            messageSize: info.messageSize,
                            response: '250 OK: message queued'
                        });
                        done();
                    }
                );
            });

            it('should receive error for 8-bit content without 8BITMIME declaration', (t, done) => {
                client.send(
                    {
                        use8BitMime: false,
                        from: 'test@valid.sender',
                        to: ['test1@valid.recipient', 'test2@invalid.recipient', 'test3õ@valid.recipient']
                    },
                    'õõõõ',
                    err => {
                        assert.strictEqual(/8 bit content not allowed/.test(err.message), true);
                        done();
                    }
                );
            });

            it('should return error for invalidly formatted recipients', (t, done) => {
                client.send(
                    {
                        from: 'test@valid.sender',
                        to: ['test@valid.recipient', '"address\r\n with folding"@valid.recipient']
                    },
                    'test',
                    err => {
                        assert.strictEqual(/^Invalid recipient/.test(err.message), true);
                        done();
                    }
                );
            });

            it('should sanitize CRLF in envelope size to prevent SMTP injection', (t, done) => {
                client.send(
                    {
                        from: 'test@valid.sender',
                        to: ['test@valid.recipient'],
                        size: '100\r\nRCPT TO:<attacker@evil.com>'
                    },
                    'test',
                    (err, info) => {
                        assert.ok(!err);
                        assert.deepStrictEqual(info.accepted, ['test@valid.recipient']);
                        assert.ok(!info.accepted.includes('attacker@evil.com'));
                        assert.ok(!info.rejected.includes('attacker@evil.com'));
                        done();
                    }
                );
            });

            it('should return error for no valid recipients', (t, done) => {
                client.send(
                    {
                        from: 'test@valid.sender',
                        to: ['test1@invalid.recipient', 'test2@invalid.recipient', 'test3@invalid.recipient']
                    },
                    'test',
                    err => {
                        assert.ok(err);
                        done();
                    }
                );
            });

            it('should return error for invalid sender', (t, done) => {
                client.send(
                    {
                        from: 'test@invalid.sender',
                        to: 'test@valid.recipient'
                    },
                    'test',
                    err => {
                        assert.ok(err);
                        done();
                    }
                );
            });

            it('should send message string', (t, done) => {
                let chunks = [],
                    message = new Array(1024).join('teretere, vana kere\n');

                server.on('data', (connection, chunk) => {
                    chunks.push(chunk);
                });

                server.removeAllListeners('dataReady');
                server.on('dataReady', (connection, callback) => {
                    let body = Buffer.concat(chunks);
                    assert.strictEqual(body.toString(), message.trim().replace(/\n/g, '\r\n'));
                    callback(null, 'ABC1');
                });

                client.send(
                    {
                        from: 'test@valid.sender',
                        to: 'test@valid.recipient'
                    },
                    message,
                    err => {
                        assert.ok(!err);
                        done();
                    }
                );
            });

            it('should send message buffer', (t, done) => {
                let chunks = [],
                    message = Buffer.from(new Array(1024).join('teretere, vana kere\n'));

                server.on('data', (connection, chunk) => {
                    chunks.push(chunk);
                });

                server.removeAllListeners('dataReady');
                server.on('dataReady', (connection, callback) => {
                    let body = Buffer.concat(chunks);
                    assert.strictEqual(body.toString(), message.toString().trim().replace(/\n/g, '\r\n'));
                    callback(null, 'ABC1');
                });

                client.send(
                    {
                        from: 'test@valid.sender',
                        to: 'test@valid.recipient'
                    },
                    message,
                    err => {
                        assert.ok(!err);
                        done();
                    }
                );
            });

            it('should send message stream', (t, done) => {
                let chunks = [],
                    fname = __dirname + '/../../LICENSE',
                    message = fs.readFileSync(fname, 'utf-8');

                server.on('data', (connection, chunk) => {
                    chunks.push(chunk);
                });

                server.removeAllListeners('dataReady');
                server.on('dataReady', (connection, callback) => {
                    let body = Buffer.concat(chunks);
                    assert.strictEqual(body.toString(), message.toString().trim().replace(/\n/g, '\r\n'));
                    callback(null, 'ABC1');
                });

                client.send(
                    {
                        from: 'test@valid.sender',
                        to: 'test@valid.recipient'
                    },
                    fs.createReadStream(fname),
                    err => {
                        assert.ok(!err);
                        done();
                    }
                );
            });
        });
    });
});

function proxyConnect(port, host, destinationPort, destinationHost, callback) {
    let socket = net.connect(port, host, () => {
        socket.write('CONNECT ' + destinationHost + ':' + destinationPort + ' HTTP/1.1\r\n\r\n');

        let headers = '';
        let onSocketData = chunk => {
            let match;
            let remainder;

            headers += chunk.toString('binary');
            if ((match = headers.match(/\r\n\r\n/))) {
                socket.removeListener('data', onSocketData);
                remainder = headers.substr(match.index + match[0].length);
                headers = headers.substr(0, match.index);
                if (remainder) {
                    socket.unshift(Buffer.from(remainder, 'binary'));
                }
                // proxy connection is now established
                return callback(null, socket);
            }
        };
        socket.on('data', onSocketData);
    });

    socket.on('error', err => {
        assert.ok(!err);
    });
}
