'use strict';

/**
 * An addr-spec sitting inside free text, together with the whitespace around it. Sticky
 * on purpose: it is run at the one offset _looseAddressStart picks rather than being let
 * loose to search, see there.
 */
const LOOSE_TEXT_ADDR = /\s*\b[^@\s]+@[^\s]+\b\s*/y;

/**
 * The characters JS `\s` matches, which the scan below has to agree with to land on the
 * same match the pattern would.
 *
 * @param {Number} code Character code
 * @return {Boolean} true if the character is whitespace
 */
function _isSpaceCode(code) {
    return (
        code === 0x20 ||
        (code >= 0x09 && code <= 0x0d) ||
        code === 0xa0 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000 ||
        code === 0xfeff
    );
}

/**
 * The characters JS `\w` matches without the unicode flag, the set the `\b` in
 * LOOSE_TEXT_ADDR is read against. charCodeAt off either end of the string gives NaN,
 * which compares false throughout, so out of range reads as the non-word the pattern
 * treats them as.
 *
 * @param {Number} code Character code
 * @return {Boolean} true if the character is a word character
 */
function _isWordCode(code) {
    return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || code === 0x5f;
}

/**
 * Whether `\b` holds at an offset
 *
 * @param {String} text Text to check
 * @param {Number} at Offset to check
 * @return {Boolean} true if there is a word boundary at the offset
 */
function _isBoundary(text, at) {
    return _isWordCode(text.charCodeAt(at - 1)) !== _isWordCode(text.charCodeAt(at));
}

/**
 * Finds the offset LOOSE_TEXT_ADDR matches at, or -1 when it does not match at all.
 *
 * Letting the pattern search for itself is quadratic: '[^@\s]+' is retried from every
 * offset and rescans the run to the next '@' each time, so 140KB of header holding no
 * usable '@' blocks the event loop for about ten seconds (GHSA-v53p-9fqp-m79j). The search is also unnecessary.
 * '[^@\s]+' crosses neither whitespace nor a '@', so a match can only begin at the head of
 * a whitespace delimited run or just past a '@' inside one, and '[^\s]+\b' gives characters
 * back until it lands on a boundary, so the only end it can take in that run is the last
 * boundary in it. Both are found in one pass, and the pattern is then run at that single
 * offset.
 *
 * The offset of the next '@' is carried from one run to the next. Looking it up afresh for
 * every run would rescan the rest of the text each time no '@' is left, which makes a value
 * of many short runs quadratic again.
 *
 * @param {String} text Free text to look in
 * @return {Number} Offset to match at, or -1
 */
function _looseAddressStart(text) {
    let len = text.length;
    let pos = 0;
    let nextAt = -1;

    while (pos < len) {
        while (pos < len && _isSpaceCode(text.charCodeAt(pos))) {
            pos++;
        }
        if (pos >= len) {
            break;
        }

        let runStart = pos;
        let runEnd = pos;
        while (runEnd < len && !_isSpaceCode(text.charCodeAt(runEnd))) {
            runEnd++;
        }

        if (nextAt < runStart) {
            nextAt = text.indexOf('@', runStart);
            if (nextAt < 0) {
                // no '@' anywhere in the rest of the text, so nothing past here can match
                break;
            }
        }

        let at = nextAt;
        if (at < runEnd) {
            let lastBoundary = -1;
            for (let k = runEnd; k > runStart; k--) {
                if (_isBoundary(text, k)) {
                    lastBoundary = k;
                    break;
                }
            }

            let atomStart = runStart;
            while (lastBoundary >= 0 && at >= 0 && at < runEnd) {
                // '[^@\s]+' has to cover a character before the '@' and '[^\s]+' one after it,
                // and the boundary that ends the match has to sit past both
                if (at > atomStart && runEnd > at + 1 && lastBoundary > at + 1) {
                    for (let start = atomStart; start < at; start++) {
                        if (_isBoundary(text, start)) {
                            if (start > runStart) {
                                return start;
                            }
                            // the leading '\s*' is greedy, so a match that begins at the run
                            // takes the whitespace in front of it along
                            let padded = runStart;
                            while (padded > 0 && _isSpaceCode(text.charCodeAt(padded - 1))) {
                                padded--;
                            }
                            return padded;
                        }
                    }
                }
                atomStart = at + 1;
                at = text.indexOf('@', atomStart);
            }

            if (at < 0) {
                break;
            }
            nextAt = at;
        }

        pos = runEnd;
    }

    return -1;
}

/**
 * Converts tokens for a single address into an address object
 *
 * @param {Array} tokens Tokens object
 * @param {Number} depth Current recursion depth for nested group protection
 * @return {Object} Address object
 */
function _handleAddress(tokens, depth) {
    let isGroup = false;
    let state = 'text';
    let address;
    let addresses = [];
    let data = {
        address: [],
        comment: [],
        group: [],
        text: [],
        textWasQuoted: [] // Track which text tokens came from inside quotes
    };
    let i;
    let len;
    let insideQuotes = false; // Track if we're currently inside a quoted string

    // Filter out <addresses>, (comments) and regular text
    for (i = 0, len = tokens.length; i < len; i++) {
        let token = tokens[i];
        if (token.type === 'operator') {
            switch (token.value) {
                case '<':
                    state = 'address';
                    insideQuotes = false;
                    break;
                case '(':
                    state = 'comment';
                    insideQuotes = false;
                    break;
                case ':':
                    state = 'group';
                    isGroup = true;
                    insideQuotes = false;
                    break;
                case '"':
                    // Track quote state for text tokens
                    insideQuotes = !insideQuotes;
                    state = 'text';
                    break;
                default:
                    state = 'text';
                    insideQuotes = false;
            }
        } else if (token.value) {
            if (state === 'address') {
                // handle use case where unquoted name includes a "<"
                // Apple Mail truncates everything between an unexpected < and an address
                // and so will we
                token.value = token.value.replace(/^[^<]*<\s*/, '');
            }
            data[state].push(token.value);
            if (state === 'text') {
                data.textWasQuoted.push(insideQuotes);
            }
        }
    }

    // If there is no text but a comment, replace the two
    if (!data.text.length && data.comment.length) {
        data.text = data.comment;
        data.comment = [];
    }

    if (isGroup) {
        // http://tools.ietf.org/html/rfc2822#appendix-A.1.3
        data.text = data.text.join(' ');

        // Parse group members, but flatten any nested groups (RFC 5322 doesn't allow nesting)
        let groupMembers = [];
        if (data.group.length) {
            let parsedGroup = addressparser(data.group.join(','), { _depth: depth + 1 });
            // Flatten: if any member is itself a group, extract its members into the sequence
            parsedGroup.forEach(member => {
                if (member.group) {
                    // Nested group detected - flatten it by adding its members directly
                    groupMembers = groupMembers.concat(member.group);
                } else {
                    groupMembers.push(member);
                }
            });
        }

        addresses.push({
            name: data.text || (address && address.name),
            group: groupMembers
        });
    } else {
        // If no address was found, try to detect one from regular text
        if (!data.address.length && data.text.length) {
            for (i = data.text.length - 1; i >= 0; i--) {
                // Security fix: Do not extract email addresses from quoted strings
                // RFC 5321 allows @ inside quoted local-parts like "user@domain"@example.com
                // Extracting emails from quoted text leads to misrouting vulnerabilities
                if (!data.textWasQuoted[i] && data.text[i].match(/^[^@\s]+@[^@\s]+$/)) {
                    data.address = data.text.splice(i, 1);
                    data.textWasQuoted.splice(i, 1);
                    break;
                }
            }

            // still no address
            if (!data.address.length) {
                for (i = data.text.length - 1; i >= 0; i--) {
                    // Security fix: Do not extract email addresses from quoted strings
                    if (!data.textWasQuoted[i]) {
                        // fixed the regex to parse email address correctly when email address has more than one @
                        let part = data.text[i];
                        let remainder = part;

                        // Security fix: locate the match offset in a single linear pass and run the
                        // sticky pattern only there, instead of letting the regex search (quadratic)
                        let at = _looseAddressStart(part);
                        if (at >= 0) {
                            LOOSE_TEXT_ADDR.lastIndex = at;
                            let match = LOOSE_TEXT_ADDR.exec(part);
                            if (match) {
                                data.address = [match[0].trim()];
                                remainder = part.slice(0, at) + ' ' + part.slice(at + match[0].length);
                            }
                        }

                        data.text[i] = remainder.trim();
                        if (data.address.length) {
                            break;
                        }
                    }
                }
            }
        }

        // If there's still is no text but a comment exixts, replace the two
        if (!data.text.length && data.comment.length) {
            data.text = data.comment;
            data.comment = [];
        }

        // Keep only the first address occurence, push others to regular text
        if (data.address.length > 1) {
            data.text = data.text.concat(data.address.splice(1));
        }

        // Join values with spaces
        data.text = data.text.join(' ');
        data.address = data.address.join(' ');

        if (!data.address && isGroup) {
            return [];
        } else {
            address = {
                address: data.address || data.text || '',
                name: data.text || data.address || ''
            };

            if (address.address === address.name) {
                if ((address.address || '').match(/@/)) {
                    address.name = '';
                } else {
                    address.address = '';
                }
            }

            addresses.push(address);
        }
    }

    return addresses;
}

/**
 * Creates a Tokenizer object for tokenizing address field strings
 *
 * @constructor
 * @param {String} str Address field string
 */
class Tokenizer {
    constructor(str) {
        this.str = (str || '').toString();
        this.operatorCurrent = '';
        this.operatorExpecting = '';
        this.node = null;
        this.escaped = false;

        this.list = [];
        /**
         * Operator tokens and which tokens are expected to end the sequence
         */
        this.operators = {
            '"': '"',
            '(': ')',
            '<': '>',
            ',': '',
            ':': ';',
            // Semicolons are not a legal delimiter per the RFC2822 grammar other
            // than for terminating a group, but they are also not valid for any
            // other use in this context.  Given that some mail clients have
            // historically allowed the semicolon as a delimiter equivalent to the
            // comma in their UI, it makes sense to treat them the same as a comma
            // when used outside of a group.
            ';': ''
        };
    }

    /**
     * Tokenizes the original input string
     *
     * @return {Array} An array of operator|text tokens
     */
    tokenize() {
        let chr,
            list = [];
        for (let i = 0, len = this.str.length; i < len; i++) {
            chr = this.str.charAt(i);
            this.checkChar(chr);
        }

        this.list.forEach(node => {
            node.value = (node.value || '').toString().trim();
            if (node.value) {
                list.push(node);
            }
        });

        return list;
    }

    /**
     * Checks if a character is an operator or text and acts accordingly
     *
     * @param {String} chr Character from the address field
     */
    checkChar(chr) {
        if (this.escaped) {
            // ignore next condition blocks
        } else if (chr === this.operatorExpecting) {
            this.node = {
                type: 'operator',
                value: chr
            };
            this.list.push(this.node);
            this.node = null;
            this.operatorExpecting = '';
            this.escaped = false;
            return;
        } else if (!this.operatorExpecting && chr in this.operators) {
            this.node = {
                type: 'operator',
                value: chr
            };
            this.list.push(this.node);
            this.node = null;
            this.operatorExpecting = this.operators[chr];
            this.escaped = false;
            return;
        } else if (['"', "'"].includes(this.operatorExpecting) && chr === '\\') {
            this.escaped = true;
            return;
        }

        if (!this.node) {
            this.node = {
                type: 'text',
                value: ''
            };
            this.list.push(this.node);
        }

        if (chr === '\n') {
            // Convert newlines to spaces. Carriage return is ignored as \r and \n usually
            // go together anyway and there already is a WS for \n. Lone \r means something is fishy.
            chr = ' ';
        }

        if (chr.charCodeAt(0) >= 0x21 || [' ', '\t'].includes(chr)) {
            // skip command bytes
            this.node.value += chr;
        }

        this.escaped = false;
    }
}

/**
 * Maximum recursion depth for parsing nested groups.
 * RFC 5322 doesn't allow nested groups, so this is a safeguard against
 * malicious input that could cause stack overflow.
 */
const MAX_NESTED_GROUP_DEPTH = 50;

/**
 * Parses structured e-mail addresses from an address field
 *
 * Example:
 *
 *    'Name <address@domain>'
 *
 * will be converted to
 *
 *     [{name: 'Name', address: 'address@domain'}]
 *
 * @param {String} str Address field
 * @param {Object} options Optional options object
 * @param {Number} options._depth Internal recursion depth counter (do not set manually)
 * @return {Array} An array of address objects
 */
function addressparser(str, options) {
    options = options || {};
    let depth = options._depth || 0;

    // Prevent stack overflow from deeply nested groups (DoS protection)
    if (depth > MAX_NESTED_GROUP_DEPTH) {
        return [];
    }

    let tokenizer = new Tokenizer(str);
    let tokens = tokenizer.tokenize();

    let addresses = [];
    let address = [];
    let parsedAddresses = [];

    tokens.forEach(token => {
        if (token.type === 'operator' && (token.value === ',' || token.value === ';')) {
            if (address.length) {
                addresses.push(address);
            }
            address = [];
        } else {
            address.push(token);
        }
    });

    if (address.length) {
        addresses.push(address);
    }

    addresses.forEach(address => {
        address = _handleAddress(address, depth);
        // Appended in place. Rebuilding the accumulator with concat() would copy every
        // entry collected so far on each address, making a flat list cost O(n^2).
        for (let i = 0; i < address.length; i++) {
            parsedAddresses.push(address[i]);
        }
    });

    if (options.flatten) {
        let addresses = [];
        let walkAddressList = list => {
            list.forEach(address => {
                if (address.group) {
                    return walkAddressList(address.group);
                } else {
                    addresses.push(address);
                }
            });
        };
        walkAddressList(parsedAddresses);
        return addresses;
    }

    return parsedAddresses;
}

// expose to the world
module.exports = addressparser;
