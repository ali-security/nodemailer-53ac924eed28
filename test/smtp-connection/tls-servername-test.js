'use strict';

/**
 * The DNS cache used to store the TLS server name of the first connection that
 * resolved a host, and later connections to that host sent it as SNI in place
 * of their own tls.servername. Three connections, three server names, and the
 * server records what each handshake carried.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const dns = require('node:dns');
const SMTPConnection = require('../../lib/smtp-connection');
const shared = require('../../lib/shared');
const SMTPServer = require('smtp-server').SMTPServer;

// resolved by a stubbed resolver, so the lookup lands in the cache without any network
const HOST = 'servername.invalid';

describe('TLS server name', () => {
    let server;
    let port;
    // the SNI value of each handshake, in connection order
    const observed = [];

    before((t, done) => {
        server = new SMTPServer({
            secure: true,
            authOptional: true,
            logger: false,
            onSecure(socket, session, callback) {
                observed.push(session.servername);
                callback();
            }
        });

        server.listen(0, '127.0.0.1', () => {
            port = server.server.address().port;
            done();
        });
    });

    after((t, done) => {
        server.close(done);
    });

    const connect = (servername, callback) => {
        let finished = false;
        const finish = err => {
            if (finished) {
                return;
            }
            finished = true;
            callback(err);
        };

        const client = new SMTPConnection({
            host: HOST,
            port,
            secure: true,
            // the stubbed address is a loopback one
            allowInternalNetworkInterfaces: true,
            tls: servername ? { rejectUnauthorized: false, servername } : { rejectUnauthorized: false },
            logger: false
        });
        client.on('error', finish);
        client.on('end', () => finish());
        client.connect(() => client.quit());
    };

    it('sends the server name of each connection, not the one of the first to resolve the host', (t, done) => {
        shared.dnsCache.delete(HOST);
        t.mock.method(dns.Resolver.prototype, 'resolve4', (hostname, cb) => {
            cb(null, ['127.0.0.1']);
        });
        t.mock.method(dns.Resolver.prototype, 'resolve6', (hostname, cb) => {
            cb(null, []);
        });

        const finish = err => {
            t.mock.restoreAll();
            shared.dnsCache.delete(HOST);
            if (err) {
                return done(err);
            }
            assert.deepStrictEqual(observed, ['first.example.com', 'second.example.com', HOST]);
            done();
        };

        connect('first.example.com', err => {
            if (err) {
                return finish(err);
            }
            // the first connection resolved the host, the others answer from the cache
            assert.ok(shared.dnsCache.has(HOST));
            connect('second.example.com', err => {
                if (err) {
                    return finish(err);
                }
                connect(undefined, finish);
            });
        });
    });
});
