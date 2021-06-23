/*******************************************************************************
**
** This file is part of betterredditmotes.
** Copyright (c) 2012-2015 Typhos.
** Copyright (c) 2015 TwilightShadow1.
**
** This program is free software: you can redistribute it and/or modify it
** under the terms of the GNU Affero General Public License as published by
** the Free Software Foundation, either version 3 of the License, or (at your
** option) any later version.
**
** This program is distributed in the hope that it will be useful, but WITHOUT
** ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
** FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public License
** for more details.
**
** You should have received a copy of the GNU Affero General Public License
** along with this program.  If not, see <http://www.gnu.org/licenses/>.
**
*******************************************************************************/

(function(_global_this) {
"use strict";

var _checkpoint = (function() {
    var _start_time = Date.now(); // Grab this value before we do ANYTHING else
    var _last_time = _start_time;
    var _last_checkpoint = "head";

    return function(name) {
        var now = Date.now();
        var delta = (now - _last_time);
        var total = (now - _start_time);
        log_debug("Timing: " + _last_checkpoint + "->" + name + " = " + delta + " (total " + total + ")");

        _last_time = now;
        _last_checkpoint = name;
    };
})();

var DEV_MODE = false;

// Domain names on which the global emote converter will refuse to run,
// typically due to bad behavior. A common problem is JS attempting to
// dynamically manipulate page stylesheets, which will fail when it hits ours
// (as reading links back to chrome addresses are generally forbidden).
var DOMAIN_BLACKLIST = [
    "read.amazon.com", // Reads document.styleSheets and crashes
    "outlook.com", // Reported conflict; cause unknown
    "panelbase.net", // Reported conflict; cause unknown
    "fimfiction.net",
    "starnetb.lcc.edu" // Reported conflict
];


// Used to determine which domain BPM is running on.
// This affects button injection and some css classes.
var is_reddit = false;
var is_modreddit = false;
var is_voat = false;
if (ends_with(document.location.hostname, "mod.reddit.com")) {
    is_modreddit = true;
} else if (ends_with(document.location.hostname, "reddit.com")) {
    is_reddit = true;
} else if (ends_with(document.location.hostname, "voat.co")) {
    is_voat = true;
}
/*
 * Inspects the environment for global variables.
 *
 * On some platforms- particularly some userscript engines- the global this
 * object !== window, and the two may have significantly different properties.
 */
function find_global(name) {
    return _global_this[name] || window[name] || undefined;
}

// Try to fool AMO.
var ST = setTimeout;
var IHTML = "innerHTML";

/*
 * Log functions. You should use these in preference to console.log(), which
 * isn't always available.
 */
var _log_buffer = [];
_global_this.bpm_logs = _log_buffer; // For console access

var _LOG_DEBUG = 0;
var _LOG_INFO = 1;
var _LOG_WARNING = 2;
var _LOG_ERROR = 3;
var _LOG_LEVEL = DEV_MODE ? _LOG_DEBUG : _LOG_WARNING;

var _console = find_global("console");
var _gm_log = find_global("GM_log");
var _raw_log;

var CONTAINER_PADDING = 10;

if(_console && _console.log) {
    _raw_log = _console.log.bind(_console);
} else if(_gm_log) {
    _raw_log = function() {
        var args = Array.prototype.slice.call(arguments);
        var msg = args.join(" ");
        _gm_log(msg);
    };
} else {
    // ?!?
    _raw_log = function() {};
}

function _wrap_logger(cname, prefix, level) {
    var cfunc;
    if(_console && _console[cname]) {
        cfunc = _console[cname].bind(_console);
    } else {
        cfunc = _raw_log;
    }
    return function() {
        var args = Array.prototype.slice.call(arguments);
        args.unshift(prefix);
        if(window.name) {
            args.unshift("[" + window.name + "]:");
        }
        _log_buffer.push(args.join(" "));
        args.unshift("BPM:");
        if(_LOG_LEVEL <= level) {
            cfunc.apply(null, args);
        }
    };
}

var log_debug = _wrap_logger("log", "DEBUG:", _LOG_DEBUG);
var log_info = _wrap_logger("log", "INFO:", _LOG_INFO);
var log_warning = _wrap_logger("warn", "WARNING:", _LOG_WARNING);
var log_error = _wrap_logger("error", "ERROR:", _LOG_ERROR);
var log_trace = function() {};
if(_console && _console.trace) {
    log_trace = _console.trace.bind(_console);
}

/*
 * A string referring to the current platform BPM is running on. This is a
 * best guess, made by inspecting global variables, and needed because this
 * script runs unmodified on all supported platforms.
 */
var platform;
// FIXME: "self" is a standard object, though self.on is specific to
// Firefox content scripts. I'd prefer something a little more clearly
// affiliated, though.
if(self.on) {
    platform = "firefox-ext";
} else if(find_global("chrome") && chrome.runtime) {
    platform = "chrome-ext"; // AKA webext
} else if(find_global("safari") && window.name === "") {
    platform = "safari-ext";
} else {
    log_error("Unknown platform! Your installation is badly broken.");
    platform = "unknown";
    // may as well just die at this point; nothing will actually work
    // For some reason Safari doesn't behave properly when frames get involved.
    // I'll continue to investigate, but for now it will just have to keep
    // spitting out errors for each frame in the document.
}

log_debug("Platform:", platform);

/*
 * Wraps a function with an error-detecting variant. Useful for callbacks
 * and the like, since some browsers (Firefox...) have a way of swallowing
 * exceptions.
 */
function catch_errors(f) {
    return function() {
        try {
            return f.apply(this, arguments);
        } catch(e) {
            log_error("Exception on line " + e.lineNumber + ": ", e.name + ": " + e.message);
            if(e.trace) {
                log_error("Stack trace:");
                log_error(e.trace);
            } else {
                log_error("Current stack:");
                // This probably isn't very useful...
                log_trace();
            }
            throw e;
        }
    };
}

/*
 * Usage: with_dom(function() { ... code ... });
 */
var with_dom = (function() {
    var callbacks = [];
    var listening = false;
    var is_ready = function() {
        return (document.readyState === "interactive" || document.readyState === "complete");
    };
    var ready = is_ready();

    if(ready) {
        log_debug("Document loaded on startup");
    }

    var loaded = function(event) {
        log_debug("Document loaded");
        _checkpoint("dom");
        ready = true;

        for(var i = 0; i < callbacks.length; i++) {
            callbacks[i]();
        }

        callbacks = null; // unreference, just in case
    };

    var add = function(callback) {
        if(ready || is_ready()) {
            callback();
        } else {
            callbacks.push(callback);
            if(!listening) {
                listening = true;
                document.addEventListener("DOMContentLoaded", catch_errors(loaded), false);
            }
        }
    };

    return add;
})();

/*
 * A reference to the MutationObserver object. It's unprefixed on Firefox,
 * but not on Chrome. Safari presumably has this as well. Defined to be
 * null on platforms that don't support it.
 */
var MutationObserver = (find_global("MutationObserver") || find_global("WebKitMutationObserver") || find_global("MozMutationObserver") || null);

/*
 * MutationObserver wrapper.
 */
function observe_document(callback) {
    if(!MutationObserver) {
        // Crash and burn. No fallbacks due to not wanting to deal with AMO
        // right now.
        log_error("MutationObserver not found!");
        return;
    }

    var observer = new MutationObserver(catch_errors(function(mutations, observer) {
        for(var m = 0; m < mutations.length; m++) {
            var added = mutations[m].addedNodes;
            if(!added || !added.length) {
                continue; // Nothing to do
            }

            callback(added);
        }
    }));

    try {
        // FIXME: For some reason observe(document.body, [...]) doesn't work
        // on Firefox. It just throws an exception. document works.
        observer.observe(document, {"childList": true, "subtree": true});
        return;
    } catch(e) {
        // Failed with whatever the error of the week is
        log_warning("Can't use MutationObserver: L" + e.lineNumber + ": ", e.name + ": " + e.message + ")");
    }
}

var _tag_blacklist = {
    // Meta tags we should never touch
    "HEAD": 1, "TITLE": 1, "BASE": 1, "LINK": 1, "META": 1, "STYLE": 1, "SCRIPT": 1,
    // Things I'm worried about
    "IFRAME": 1, "OBJECT": 1, "CANVAS": 1, "SVG": 1, "MATH": 1, "TEXTAREA": 1
};

/*
 * Walks the DOM tree from the given root, running a callback on each node
 * where its nodeType === node_filter. Pass only three arguments.
 *
 * This is supposed to be much faster than TreeWalker, and also chunks its
 * work into batches of 1000, waiting 50ms in between in order to ensure
 * browser responsiveness no matter the size of the tree.
 */
function walk_dom(root, node_filter, process, end, node, depth) {
    if(!node) {
        if(_tag_blacklist[root.tagName]) {
            return; // A bit odd, but possible
        } else {
            // Treat root as a special case
            if(root.nodeType === node_filter) {
                process(root);
            }
            node = root.firstChild;
            depth = 1;
        }
    }
    var num = 1000;
    // If the node/root was null for whatever reason, we die here
    while(node && num > 0) {
        num--;
        if(!_tag_blacklist[node.tagName]) {
            // Only process valid nodes.
            if(node.nodeType === node_filter) {
                process(node);
            }
            // Descend (but never into blacklisted tags).
            if(node.hasChildNodes()) {
                node = node.firstChild;
                depth++;
                continue;
            }
        }
        while(!node.nextSibling) {
            node = node.parentNode;
            depth--;
            if(!depth) {
                end();
                return; // Done!
            }
        }
        node = node.nextSibling;
    }
    if(num) {
        // Ran out of nodes, or hit null somehow. I'm not sure how either
        // of these can happen, but oh well.
        end();
    } else {
        ST(catch_errors(function() {
            walk_dom(root, node_filter, process, end, node, depth);
        }), 50);
    }
}

/*
 * Helper function to make elements "draggable", i.e. clicking and dragging
 * them will move them around.
 *
 * N.b. have to do stupid things with event names due to AMO.
 */
function enable_drag(element, start_callback, callback) {
    var start_x, start_y;

    var on_mouse_move = catch_errors(function(event) {
        var dx = event.clientX - start_x;
        var dy = event.clientY - start_y;
        callback(event, dx, dy);
    });

    element.addEventListener("mousedown", catch_errors(function(event) {
        start_x = event.clientX;
        start_y = event.clientY;
        window.addEventListener("mouse" + "move", on_mouse_move, false);
        document.body.classList.add("bpm-noselect");
        start_callback(event);
    }), false);

    window.addEventListener("mouseup", catch_errors(function(event) {
        window.removeEventListener("mouse" + "move", on_mouse_move, false);
        document.body.classList.remove("bpm-noselect");
    }), false);
}

/*
 * Wrapper around enable_drag for the common case of moving elements.
 */
function make_movable(element, container, callback) {
    var start_x, start_y;

    enable_drag(element, function(event) {
        start_x = parseInt(container.style.left, 10);
        start_y = parseInt(container.style.top, 10);
    }, function(event, dx, dy) {
        var container_width = parseInt(container.style.width, 10) || 0;
        var container_height = parseInt(container.style.height, 10) || 0;

        var minX = CONTAINER_PADDING;
        var minY = CONTAINER_PADDING;

        var maxX = window.innerWidth - container_width - CONTAINER_PADDING;
        var maxY = window.innerHeight - container_height - CONTAINER_PADDING;

        var left = Math.max(Math.min(start_x + dx, maxX), minX);
        var top = Math.max(Math.min(start_y + dy, maxY), minY);

        function move() {
            container.style.left = left + "px";
            container.style.top = top + "px";
        }

        if(callback) {
            callback(event, left, top, move);
        } else {
            move();
        }
    });
}

function keep_on_window(container) {
    var start_x = parseInt(container.style.left, 10);
    var start_y = parseInt(container.style.top, 10);

    var container_width = parseInt(container.style.width, 10);
    var container_height = parseInt(container.style.height, 10);

    var minX = CONTAINER_PADDING;
    var minY = CONTAINER_PADDING;

    var maxX = window.innerWidth - container_width - CONTAINER_PADDING;
    var maxY = window.innerHeight - container_height - CONTAINER_PADDING;

    var left = Math.max(Math.min(start_x, maxX), minX);
    var top = Math.max(Math.min(start_y, maxY), minY);

    container.style.left = left + "px";
    container.style.top = top + "px";
}

/*
 * Makes a nice <style> element out of the given CSS.
 */
function style_tag(css) {
    log_debug("Building <style> tag");
    var tag = document.createElement("style");
    tag.type = "text/css";
    tag.textContent = css;
    return tag;
}

/*
 * Makes a nice <link> element to the given URL (for CSS).
 */
function stylesheet_link(url) {
    log_debug("Building <link> tag to", url);
    var tag = document.createElement("link");
    tag.href = url;
    tag.rel = "stylesheet";
    tag.type = "text/css";
    return tag;
}

/*
 * Determines whether this element, or any ancestor, have the given id.
 */
function id_above(element, id) {
    while(true) {
        if(element.id === id) {
            return true;
        } else if(element.parentElement) {
            element = element.parentElement;
        } else {
            return false;
        }
    }
}

/*
 * Determines whether this element, or any ancestor, have the given class.
 */
function class_above(element, class_name) {
    while(true) {
        if(element.classList.contains(class_name)) {
            return element;
        } else if(element.parentElement) {
            element = element.parentElement;
        } else {
            return null;
        }
    }
}

/*
 * Locates an element at or above the given one matching a particular test.
 */
function locate_matching_ancestor(element, predicate, none) {
    while(true) {
        if(predicate(element)) {
            return element;
        } else if(element.parentElement) {
            element = element.parentElement;
        } else {
            return none;
        }
    }
}

/*
 * Locates an element with the given class name. Logs a warning message if
 * more than one element matches. Returns null if there wasn't one.
 */
function find_class(root, class_name) {
    var elements = root.getElementsByClassName(class_name);
    if(!elements.length) {
        return null;
    } else if(elements.length === 1) {
        return elements[0];
    } else {
        log_warning("Multiple elements under", root, "with class '" + class_name + "'");
        return elements[0];
    }
}

/* str.startswith() and str.endswith() */
function starts_with(text, s) {
    return text.slice(0, s.length) === s;
}

function ends_with(text, s) {
    return text.slice(-s.length) === s;
}

/*
 * Lazy way to get to A.slice() on any list-like. Useful for getElements()
 * calls, since the returned objects are slow to access.
 */
var slice = Array.prototype.slice.call.bind(Array.prototype.slice);
/*
 * Browser compatibility.
 */

/*
 * Returns an object that CSS-related tags can be attached to before the DOM
 * is built. May be undefined or null if there is no such object.
 */
function _css_parent() {
    return document.head || null;
}

/*
 * Trigger called when _css_parent() is available. May defer until with_dom().
 */
function with_css_parent(callback) {
    if(_css_parent()) {
        callback();
    } else {
        with_dom(function() {
            callback();
        });
    }
}

/*
 * Appends a <style> tag for the given CSS.
 */
function add_css(css) {
    if(css) {
        var tag = style_tag(css);
        _css_parent().insertBefore(tag, _css_parent().firstChild);
    }
}

/*
 * Adds a CSS resource to the page.
 */
function link_css(filename) {
    make_css_link(filename, function(tag) {
        var parent = _css_parent();
        parent.insertBefore(tag, parent.firstChild);
    });
}

/*
 * Sends a set_pref message to the backend. Don't do this too often, as
 * some browsers incur a significant overhead for each call.
 */
var set_pref = function(key, value) {
    log_debug("Writing preference:", key, "=", value);
    _send_message("set_pref", {"pref": key, "value": value});
};

var _request_initdata = function(want) {
    _send_message("get_initdata", {"want": want});
};

var _initdata_want = null;
var _initdata_hook = null;
var setup_browser = function(want, callback) {
    _checkpoint("startup");
    _initdata_want = want;
    _initdata_hook = callback;
    _request_initdata(want);
};

function _complete_setup(initdata) {
    _checkpoint("ready");
    var store = new Store();

    if(_initdata_want.prefs) {
        if(initdata.prefs !== undefined) {
            store.setup_prefs(initdata.prefs);
        } else {
            log_error("Backend sent wrong initdata: no prefs");
            return;
        }
    }
    if(_initdata_want.customcss) {
        if(initdata.emotes !== undefined && initdata.css !== undefined) {
            store.setup_customcss(initdata.emotes, initdata.css);
        } else {
            log_error("Backend sent wrong initdata: no custom css");
            return;
        }
    }

    _initdata_hook(store);
    _initdata_want = null;
    _initdata_hook = null;
}

// Missing attributes/methods:
var _send_message = null;
var make_css_link = null;
var linkify_options = null;

switch(platform) {
case "firefox-ext":
    _send_message = function(method, data) {
        if(data === undefined) {
            data = {};
        }
        data.method = method;
        log_debug("_send_message:", data);
        self.postMessage(data);
    };

    var _data_url = function(filename) {
        // FIXME: Hardcoding this sucks. It's likely to continue working for
        // a good long while, but we should prefer make a request to the
        // backend for the prefix (not wanting to do that is the reason for
        // hardcoding it). Ideally self.data.url() would be accessible to
        // content scripts, but it's not...
        return "resource://jid1-thrhdjxskvsicw-at-jetpack/data" + filename;
    };

    make_css_link = function(filename, callback) {
        var tag = stylesheet_link(_data_url(filename));
        callback(tag);
    };

    linkify_options = function(element) {
        // Firefox doesn't permit linking to resource:// links or something
        // equivalent.
        element.addEventListener("click", catch_errors(function(event) {
            _send_message("open_options");
        }), false);
    };

    self.on("message", catch_errors(function(message) {
        switch(message.method) {
        case "initdata":
            _complete_setup(message);
            break;

        default:
            log_error("Unknown request from Firefox background script: '" + message.method + "'");
            break;
        }
    }));
    break;

case "chrome-ext":
    _send_message = function(method, data) {
        if(data === undefined) {
            data = {};
        }
        data.method = method;
        log_debug("_send_message:", data);
        chrome.runtime.sendMessage(data, _message_handler);
    };

    var _message_handler = catch_errors(function(message) {
        if(!message || !message.method) {
            log_error("Unknown request from Chrome background script: '" + message + "'");
            return;
        }

        switch(message.method) {
        case "initdata":
            _complete_setup(message);
            break;

        default:
            log_error("Unknown request from Chrome background script: '" + message.method + "'");
            break;
        }
    });

    make_css_link = function(filename, callback) {
        var tag = stylesheet_link(chrome.runtime.getURL(filename));
        callback(tag);
    };

    linkify_options = function(element) {
        element.href = chrome.runtime.getURL("/options.html");
        element.target = "_blank";
    };
    break;

case "safari-ext":
    _send_message = function(method, data) {
        if(data === undefined) {
            data = {};
        }
        data.method = method;
        log_debug("_send_message:", data);
        safari.self.tab.dispatchMessage(data.method, data);
    };

    // Safari does message handling kind of weirdly since it has a message argument built in.
    safari.self.addEventListener("message", catch_errors(function(message) {
        switch(message.message.method) {
            case "initdata":
                _complete_setup(message.message);
                break;

            default:
                log_error("Unknown request from Safari background script: '" + message.message.method + "'");
                break;
        }
    }), false);

    make_css_link = function(filename, callback) {
        var tag = stylesheet_link(safari.extension.baseURI + filename.substr(1));
        callback(tag);
    };

    linkify_options = function(element) {
        element.href = safari.extension.baseURI + 'options.html';
        element.target = "_blank";
    };
}
function Store() {
    this.prefs = null;
    this._custom_emotes = null;
    this.custom_css = null; // Accessed by init_css() so not really private

    this._sr_array = null;
    this._tag_array = null;
    this._de_map = null;
    this._we_map = null;

    this._sync_timeouts = {};

    // Can't make this a global because, on Opera, bpm-resources.js doesn't
    // seem to actually exist early on.
    this.formatting_tag_id = bpm_data.tag_name2id["+formatting"];
}

Store.prototype = {
    setup_prefs: function(prefs) {
        log_debug("Got prefs");
        this.prefs = prefs;
        this._make_sr_array();
        this._make_tag_array();
        this._de_map = this._make_emote_map(prefs.disabledEmotes);
        this._we_map = this._make_emote_map(prefs.whitelistedEmotes);

    },

    setup_customcss: function(emotes, css) {
        log_debug("Got customcss");
        this._custom_emotes = emotes;
        this.custom_css = css;
    },

    /*
     * Sync the given preference key. This may be called rapidly, as it will
     * enforce a small delay between the last sync_key() invocation and any
     * actual browser call is made.
     */
    sync_key: function(key) {
        // Schedule pref write for one second in the future, clearing out any
        // previous timeout. Prevents excessive backend calls, which can generate
        // some lag (on Firefox, at least).
        if(this._sync_timeouts[key] !== undefined) {
            clearTimeout(this._sync_timeouts[key]);
        }

        this._sync_timeouts[key] = ST(catch_errors(function() {
            set_pref(key, this.prefs[key]);
            delete this._sync_timeouts[key];
        }.bind(this)), 1000);
    },

    /*
     * Determines whether or not an emote has been disabled by the user. Returns:
     *    0: not disabled
     *    1: nsfw has been turned off
     *    2: subreddit was disabled
     *    3: too large
     *    4: blacklisted
     */
    is_disabled: function(info) {
        if(this._we_map[info.name]) {
            return 0;
        }
        if(info.is_nsfw && !this.prefs.enableNSFW) {
            return 1;
        }
        if(info.source_id !== null && !this._sr_array[info.source_id]) {
            return 2;
        }
        if(this.prefs.maxEmoteSize && info.max_size > this.prefs.maxEmoteSize) {
            return 3;
        }
        if(this._de_map[info.name]) {
            return 4;
        }
        return 0;
    },

    custom_emotes: function() {
        return this._custom_emotes;
    },

    /*
     * Tries to locate an emote, either builtin or global.
     */
    lookup_emote: function(name, want_tags) {
        return this.lookup_core_emote(name, want_tags) || this.lookup_custom_emote(name) || null;
    },

    /*
     * Looks up a builtin emote's information. Returns an object with a couple
     * of properties, or null if the emote doesn't exist.
     */
    lookup_core_emote: function(name, want_tags) {
        // Refer to bpgen.py:encode() for the details of this encoding
        var data = bpm_data.emote_map[name];
        if(!data) {
            return null;
        }

        var parts = data.split(",");
        var flag_data = parts[0];
        var tag_data = parts[1];

        var flags = parseInt(flag_data.slice(0, 1), 16);     // Hexadecimal
        var source_id = parseInt(flag_data.slice(1, 3), 16); // Hexadecimal
        var size = parseInt(flag_data.slice(3, 7), 16);      // Hexadecimal
        var is_nsfw = (flags & _FLAG_NSFW);
        var is_redirect = (flags & _FLAG_REDIRECT);

        var tags = null, base = null;
        if(want_tags) {
            var start, str;

            tags = [];
            start = 0;
            while((str = tag_data.slice(start, start+2)) !== "") {
                tags.push(parseInt(str, 16)); // Hexadecimal
                start += 2;
            }

            if(is_redirect) {
                base = parts[2];
            } else {
                base = name;
            }
        }

        return {
            name: name,
            is_nsfw: Boolean(is_nsfw),
            source_id: source_id,
            source_name: bpm_data.sr_id2name[source_id],
            max_size: size,

            tags: tags,

            css_class: "bpmote-" + sanitize_emote(name.slice(1)),
            base: base
        };
    },

    /*
     * Looks up a custom emote's information. The returned object is rather
     * sparse, but roughly compatible with core emote's properties.
     */
    lookup_custom_emote: function(name) {
        var source_subreddit = this._custom_emotes[name];
        if(source_subreddit === undefined) {
            // Emote doesn't actually exist
            return null;
        }

        return {
            name: name,
            is_nsfw: false,
            source_id: null,
            source_name: "r/" + source_subreddit,
            max_size: null,

            tags: [],

            css_class: "bpm-cmote-" + sanitize_emote(name.slice(1)),
            base: null
        };
    },

    _make_sr_array: function() {
        this._sr_array = [];
        for(var id in bpm_data.sr_id2name) {
            this._sr_array[id] = this.prefs.enabledSubreddits2[bpm_data.sr_id2name[id]];
        }
        if(this._sr_array.indexOf(undefined) > -1) {
            // Holes in the array mean holes in sr_id2name, which can't possibly
            // happen. If it does, though, any associated emotes will be hidden.
            //
            // Also bad would be items in prefs not in sr_id2name, but that's
            // more or less impossible to handle.
            log_error("sr_array has holes; installation or prefs are broken!");
        }
    },

    _make_tag_array: function() {
        this._tag_array = [];
        for(var id in bpm_data.tag_id2name) {
            this._tag_array[id] = bpm_data.tag_id2name[id];
        }
        if(this._tag_array.indexOf(undefined) > -1) {
            log_error("tag_array has holes; installation or prefs are broken!");
        }
    },

    _make_emote_map: function(list) {
        var map = {};
        for(var i = 0; i < list.length; i++) {
            map[list[i]] = 1;
        }
        return map;
    }
};

// Keep in sync with bpgen.
var _FLAG_NSFW = 1;
var _FLAG_REDIRECT = 1 << 1;

/*
 * Escapes an emote name (or similar) to match the CSS classes.
 *
 * Must be kept in sync with other copies, and the Python code.
 */
function sanitize_emote(s) {
    return s.toLowerCase().replace("!", "_excl_").replace(":", "_colon_").replace("#", "_hash_").replace("/", "_slash_");
}
/*
 * Parses a search query. Returns an object that looks like this:
 *    .sr_term_sets: list of [true/false, term] subreddit names to match.
 *    .tag_term_sets: list of [true/false, tags ...] tag sets to match.
 *    .name_terms: list of emote name terms to match.
 * or null, if there was no query.
 */
function parse_search_query(terms) {
    var query = {sr_term_sets: [], tag_term_sets: [], name_terms: []};

    /*
     * Adds a list of matching ids as one term. Cancels out earlier
     * opposites where appropriate.
     */
    function add_cancelable_id_list(sets, positive, ids) {
        // Search from right to left, looking for sets of an opposite type
        for(var set_i = sets.length - 1; set_i >= 0; set_i--) {
            var set = sets[set_i];
            if(set[0] !== positive) {
                // Look for matching ids, and remove them
                for(var id_i = ids.length - 1; id_i >= 0; id_i--) {
                    var index = set.indexOf(ids[id_i]);
                    if(index > -1) {
                        // When a tag and an antitag collide...
                        set.splice(index, 1);
                        ids.splice(id_i, 1);
                        // It makes a great big mess of my search code is what
                    }
                }
                // This set was cancelled out completely, so remove it
                if(set.length <= 1) {
                    sets.splice(set_i, 1);
                }
            }
        }
        // If there's still anything left, add this new set
        if(ids.length) {
            ids.unshift(positive);
            sets.push(ids);
        }
    }

    /*
     * Adds an id set term, by either adding it exactly or adding all
     * matching tags.
     */
    function add_id_set(sets, name2id, positive, exact, query) {
        var id = name2id[exact];
        if(id) {
            add_cancelable_id_list(sets, positive, [id]); // Exact name match
        } else {
            // Search through all tags for one that looks like the term.
            var matches = [];
            for(var name in name2id) {
                id = name2id[name];
                if(name.indexOf(query) > -1 && matches.indexOf(id) < 0) {
                    matches.push(id);
                }
            }
            // If we found anything at all, append it
            if(matches.length) {
                add_cancelable_id_list(sets, positive, matches);
            } else {
                // Else, try adding the original query. It'll probably fail to
                // match anything at all (killing the results is acceptable for
                // typos), or possibly work on custom subreddits.
                add_cancelable_id_list(sets, positive, [exact]);
            }
        }
    }

    // Parse query
    for(var t = 0; t < terms.length; t++) {
        var term = terms[t];
        var is_tag = false; // Whether it started with "+"/"-" (which could actually be a subreddit!!)
        var positive = true;
        if(term[0] === "+" || term[0] === "-") {
            // It's a thing that can be negated, which means either subreddit
            // or a tag.
            is_tag = true;
            positive = term[0] === "+";
            term = term.slice(1);
            if(!term) {
                continue;
            }
        }
        if(term.slice(0, 3) === "sr:") {
            if(term.length > 3) {
                // Chop off sr:
                add_id_set(query.sr_term_sets, bpm_data.sr_name2id, positive, term.slice(3), term.slice(3));
            }
        } else if(term.slice(0, 2) === "r/") {
            if(term.length > 2) {
                // Leave the r/ on
                add_id_set(query.sr_term_sets, bpm_data.sr_name2id, positive, term, term);
            }
        } else if(is_tag) {
            if(term.length > 1) {
                // A tag-like thing that isn't a subreddit = tag term
                add_id_set(query.tag_term_sets, bpm_data.tag_name2id, positive, "+" + term, term);
            }
        } else {
            query.name_terms.push(term); // Anything else
        }
    }

    if(query.sr_term_sets.length || query.tag_term_sets.length || query.name_terms.length) {
        return query;
    } else {
        return null;
    }
}

/*
 * Checks whether a single emote matches against a search query.
 */
function emote_matches_query(query, emote_info, lc_emote_name) {
    // Match if ALL search terms match
    for(var nt_i = 0; nt_i < query.name_terms.length; nt_i++) {
        if(lc_emote_name.indexOf(query.name_terms[nt_i]) < 0) {
            return false;
        }
    }

    // Match if AT LEAST ONE positive subreddit term matches, and NONE
    // of the negative ones.
    if(query.sr_term_sets.length) {
        var is_match = true; // Match by default, unless there are positive terms

        // Check each pile of terms
        for(var sr_set_i = 0; sr_set_i < query.sr_term_sets.length; sr_set_i++) {
            var sr_set = query.sr_term_sets[sr_set_i];

            if(sr_set[0]) {
                // If there are any positive terms, then we're wrong
                // by default. We have to match one of them (just not
                // any of the negative ones either).
                //
                // However, if there are *only* negative terms, then we
                // actually match by default.
                is_match = false;
            }

            // sr_set[0] is true/false and so can't interfere
            for(var i = 1; i < sr_set.length; i++) {
                if(sr_set[i] === emote_info.source_id || (typeof sr_set[i] === "string" && emote_info.source_name.indexOf(sr_set[i]) > -1)) {
                    if(sr_set[0]) {
                        is_match = true; // Matched positive term
                        break;
                    } else {
                        return false; // Matched negative term
                    }
                }
            }

            if(is_match) {
                break;
            }
        }

        if(!is_match) {
            return false;
        }
    }

    // Match if ALL tag sets match
    for(var tt_i = query.tag_term_sets.length - 1; tt_i >= 0; tt_i--) {
        // Match if AT LEAST ONE of these match
        var tag_set = query.tag_term_sets[tt_i];

        var any = false;
        for(var ts_i = 1; ts_i < tag_set.length; ts_i++) {
            if(emote_info.tags.indexOf(tag_set[ts_i]) > -1) {
                any = true;
                break;
            }
        }
        // We either didn't match, and wanted to, or matched and didn't
        // want to.
        if(any !== tag_set[0]) {
            return false;
        }
    }

    return true;
}

/*
 * Executes a search query. Returns an object with two properties:
 *    .results: a sorted list of emotes
 */
function execute_search(store, query) {
    var results = [];

    for(var emote_name in bpm_data.emote_map) {
        var emote_info = store.lookup_core_emote(emote_name, true);
        var lc_emote_name = emote_name.toLowerCase();

        if(!emote_matches_query(query, emote_info, lc_emote_name)) {
            continue;
        }

        // At this point we have a match, so follow back to its base
        if(emote_name !== emote_info.base) {
            // Hunt down the non-variant version
            emote_info = store.lookup_core_emote(emote_info.base, true);
            if(emote_info.name !== emote_info.base) {
                log_warning("Followed +v from " + emote_name + " to " + emote_info.name + "; no root emote found");
            }
            emote_name = emote_info.name;
        }

        results.push(emote_info);
    }

    for(var emote_name in store.custom_emotes()) {
        if(bpm_data.emote_map[emote_name] !== undefined) {
            // Quick hack: force custom emotes to lose precedence vs. core ones.
            // This is partially for consistency (this happens when converting
            // as well and would be confusing), but also to conveniently drop
            // duplicates, e.g. r/mlp copies.
            continue;
        }

        var emote_info = store.lookup_custom_emote(emote_name);
        var lc_emote_name = emote_name.toLowerCase();

        if(!emote_matches_query(query, emote_info, lc_emote_name)) {
            continue;
        }

        results.push(emote_info);
    }

    results.sort(function(a, b) {
        if(a.name < b.name) {
            return -1;
        } else if(a.name > b.name) {
            return 1;
        } else {
            return 0;
        }
    });

    return results;
}
/*
 * Generates a long random string.
 */
function random_id(length) {
    var id = "";
    for(var i = 0; i < 24; i++) {
        var index = Math.floor(Math.random() * 25);
        id += "abcdefghijklmnopqrstuvwxyz"[index];
    }
    return id;
}

/*
 * Injected code.
 */
function _msg_delegate_hack(id, message) {
    /* BPM hack to enable cross-origin frame communication in broken browsers.
       If you can see this, something broke. */
    /* Locate iframe, send message, remove class. */
    var iframe = document.getElementsByClassName(id)[0];
    if(iframe) {
        iframe.contentWindow.postMessage(message, "*");
        iframe.classList.remove(id);
        /* Locate our script tag and remove it. */
        var script = document.getElementById(id);
        script.parentNode.removeChild(script);
    }
}

/*
 * Send a message to an iframe via postMessage(), working around any browser
 * shortcomings to do so.
 *
 * "message" must be JSON-compatible.
 *
 * Note that the targetOrigin of the postMessage() call is "*", no matter
 * what. Don't send anything even slightly interesting.
 */
function message_iframe(frame, message) {
    log_debug("Sending", message, "to", frame);
    if(frame.contentWindow) {
        // Right now, only Firefox and Opera let us access this API.
        frame.contentWindow.postMessage(message, "*");
    } else {
        // Chrome and Opera don't permit *any* access to these variables for
        // some stupid reason, despite them being available on the page.
        // Inject a <script> tag that does the dirty work for us.
        var id = "__betterredditmotes_esh_" + random_id();
        frame.classList.add(id);

        // AMO.
        var a = "foo", b = "scr";
        var c = "bar", d = "ipt";
        var e = "Element";
        var tag = (a + c).replace(a, b).replace(c, d);
        var f = ("create" + c).replace(c, e);
        var e = document[f]("" + tag);

        e.type = "text/javascript";
        e.id = id;
        document.head.appendChild(e);
        e.textContent = "(" + _msg_delegate_hack.toString() + ")('" + id + "', " + JSON.stringify(message) + ");";
    }
}

// Previously focused elements. Only one of these can be non-null.
var target_form = null;
var target_frame = null;

/*
 * Caches the currently focused element, if it's something we can inject
 * emotes into.
 */
function track_focus() {
    var active = document.activeElement;

    while(active.tagName === "IFRAME") {
        // Focus is within the frame. Find the real element (recursing just
        // in case).
        if(active.contentWindow === null || active.contentWindow === undefined) {
            // Chrome is broken and does not permit us to access these
            // from content scripts.
            message_iframe(active, {
                "__betterredditmotes_method": "__bpm_track_focus"
            });

            target_form = null;
            target_frame = active;
            return;
        }

        try {
            active = active.contentDocument.activeElement;
        } catch(e) {
            // Addon SDK is broken
            message_iframe(active, {
                "__betterredditmotes_method": "__bpm_track_focus"
            });

            target_form = null;
            target_frame = active;
            return;
        }
    }

    // Ignore our own stuff and things that are not text boxes
    if(!id_above(active, "bpm-stuff") && active !== target_form &&
       active.selectionStart !== undefined && active.selectionEnd !== undefined) {
        target_form = active;
        target_frame = null;
    }
}

/*
 * Injects an emote into the given form.
 */
function inject_emote_into_form(store, target_form, emote_name) {
    log_debug("Injecting ", emote_name, "into", target_form);
    var emote_info = store.lookup_core_emote(emote_name, true);

    var start = target_form.selectionStart;
    var end = target_form.selectionEnd;
    if(start !== undefined && end !== undefined) {
        var emote_len;
        var before = target_form.value.slice(0, start);
        var inside = target_form.value.slice(start, end);
        var after = target_form.value.slice(end);
        if(inside) {
            var extra_len, emote;
            // Make selections into text/alt-text
            if(emote_info.tags.indexOf(store.formatting_tag_id) > -1) {
                extra_len = 4; // '[]('' and ')'
                emote = "[" + inside + "](" + emote_name + ")";
            } else {
                extra_len = 4; // '[](' and ' "' and '")'
                emote = "[](" + emote_name + " \"" + inside + "\")";
            }
            emote_len = extra_len + emote_name.length + (end - start);
            target_form.value = (before + emote + after);
        } else {
            // "[](" + ")"
            emote_len = 4 + emote_name.length;
            target_form.value = (
                before +
                "[](" + emote_name + ")" +
                after);
        }
        target_form.selectionStart = end + emote_len;
        target_form.selectionEnd = end + emote_len;
        target_form.focus();

        // Previous RES versions listen for keyup, but as of the time of
        // writing this, the development version listens for input. For now
        // we'll just send both, and remove the keyup one at a later date.
        var event = document.createEvent("Event");
        event.initEvent("keyup", true, true);
        target_form.dispatchEvent(event);
        event = document.createEvent("HTMLEvents");
        event.initEvent("input", true, true);
        target_form.dispatchEvent(event);
    }
}

/*
 * Injects an emote into the currently focused element, which might involve
 * dispatching into an iframe.
 */
function inject_emote(store, emote_name) {
    if(target_frame !== null) {
        message_iframe(target_frame, {
            "__betterredditmotes_method": "__bpm_inject_emote",
            "__betterredditmotes_emote": emote_name
        });
    } else if(target_form !== null) {
        inject_emote_into_form(store, target_form, emote_name);
    }
}
// Whether or not we're running on Reddit's .compact display, i.e. their mobile
// version. We modify the search box UI a fair bit to compensate in this case.
//
// i.reddit.com is another way to get the compact UI. Occasionally it'll
// redirect users to .compact links, but in the meantime we need to work
// correctly there as well.
var is_compact = ends_with(document.location.pathname, ".compact") ||
                 document.location.hostname.split(".").indexOf("i") > -1;

// Search box elements
var sb_container = null;
var sb_dragbox = null;
var sb_tagdropdown = null;
var sb_input = null;
var sb_resultinfo = null;
var sb_close = null;
var sb_tabframe = null;
var sb_results = null;
var sb_helptab = null;
var sb_helplink = null;
var sb_flagtab = null;
var sb_flaglink = null;
var sb_optionslink = null;
var sb_resize = null;
var sb_global_icon = null; // Global << thing

var sb_firstrun = false; // Whether or not we've made any search at all yet
var current_sb_tab = null;

/*
 * Sets up the search box for use on a page, either Reddit or the top-level
 * frame, globally. Also injects the global icon, though it doesn't initialize
 * it.
 */
function init_search_box(store) {
    log_debug("Initializing search box");
    inject_search_box();
    init_search_ui(store);
}

/*
 * Builds and injects the search box HTML.
 */
function inject_search_box() {
    // Placeholder div to create HTML in
    var div = document.createElement("div");
    // I'd sort of prefer display:none, but then I'd have to override it
    div.style.visibility = "hidden";
    div.id = "bpm-stuff"; // Just so it's easier to find in an elements list

    // NOTE: Do not add elements to this without first considering whether or
    // not they need to have "visibility: inherit;" in bpmotes.css. It probably
    // does. See the note there.

    var html = [
        // tabindex is a hack to make Esc work. Reddit uses this index in a
        // couple of places, so it's probably safe.
        '<div id="bpm-sb-container" tabindex="100">',
          '<div id="bpm-sb-toprow">',
            '<span id="bpm-sb-dragbox"></span>',
            '<select id="bpm-sb-tagdropdown" onchange="">',
            '<input id="bpm-sb-input" type="search" placeholder="Search"/>',
            '<span id="bpm-sb-resultinfo"></span>',
            '<span id="bpm-sb-close"></span>',
          '</div>',
          '<div id="bpm-sb-tabframe">',
            '<div id="bpm-sb-results"></div>',
            '<div id="bpm-sb-helptab">',
              '<p class="bpm-sb-help">Simple search terms will show you ',
                'emotes with names that match: for instance, <code>"ab"',
                '</code> will find all emotes with <code>"ab"</code> in ',
                'their names. If you use more than one term, all of them ',
                'must match to return an emote.</p>',
              '<p class="bpm-sb-help">You can filter by subreddit with the ',
                'special syntaxes <code>"r/subreddit"</code> and <code>"sr:',
                'subreddit"</code>. Using more than one such filter returns ',
                'results from each of them.</p>',
              '<p class="bpm-sb-help">All emotes are tagged according to ',
                'their contents, and these can be searched on like <code>',
                '"+luz"</code>. Most show characters have their ',
                'own tags that can be easily guessed, and some classes of ',
                '"themed" emotes also have tags. You can also negate tags ',
                'with <code>"-belos"</code> to remove emotes from the ',
                'results.</p>',
              '<p class="bpm-sb-help">Some emotes are hidden by default. ',
                'Use <code>"+nonwitch"</code> to see them.</p>',
            '</div>',
            '<div id="bpm-sb-flagtab">',
              '<p class="bpm-sb-flag">You can add various flags onto emotes to ',
              'change their appearance or behavior using the syntax of <code>',
              '[](#emote-flag)</code>. Also, multiple flags can be added per emote.</p>',
              '<p class="bpm-sb-flag">For instance, <code class="bpm-sb-noconvert-luz">',
              '</code> generates <a class="bpm-emote bpflag-invert bpflag-in ',
              'bpmote-luz"></a>.</p>',
              '<p class="bpm-sb-flag">If you need to type an emote in the middle of the sentence, like -> <a class="bpm-emote bpflag-in bpmote-king"></a> <- this, use the <code>-in</code> flag.</p>',
              '<p class="bpm-sb-flag">If you need to have an emote towards the right side of your comment, use the flag <code>-ar</code>.<a class="bpm-emote bpflag-ar bpflag-in bpmote-eda"></a></p>',
              '<p class="bpm-sb-flag">Most of the other flags that can be used are listed',
              ' below:</p><br><br><br><br>',
              '<center>Basics:</center>',
               '<center><table class="bpflagtable">',
                 '<tr>',
                   '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-r bpmote-amity"></a><br><center><code>-r</code></center></th>',
                   '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-d bpmote-amity"></a><br><center><code>-d</code></center></th>',
                   '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-f bpmote-amity"></a><br><center><code>-f</code></center></th>',
                   '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-45 bpmote-amity"></a><br><center><code>-45</code></center></th>',
                 //  '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-m bpmote-amity"></a><br><center><code>-m</code></center></th>',
                 '</tr>',
               '</table></center><br>',
               '<center>Colouring:</center>',
                '<center><table class="bpflagtable">',
                  '<tr>',
                    '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-i bpmote-willow"></a><br><center><code>-i</code></center></th>',
                    '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-invert bpmote-willow"></a><br><center><code>-invert</code></center></th>',
                    '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-mono bpmote-willow"></a><br><center><code>-mono</code></center></th>',
                    '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-sepia bpmote-willow"></a><br><center><code>-sepia</code></center></th>',
                    '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-blur bpmote-willow"></a><br><center><code>-blur</code></center></th>',
                  '</tr>',
                '</table></center><br>',
                '<center>Animated:</center>',
                 '<center><table class="bpflagtable">',
                   '<tr>',
                     '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-spin bpmote-hooty"></a><br><center><code>-spin</code></center></th>',
                     '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-_excl_spin bpmote-hooty"></a><br><center><code>-!spin</code></center></th>',
                     '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-xspin bpmote-hooty"></a><br><center><code>-xspin</code></center></th>',
                     '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-yspin bpmote-hooty"></a><br><center><code>-yspin</code></center></th>',
                  '</tr>',
                  '<tr>',
                    '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-zspin bpmote-hooty"></a><br><center><code>-zspin</code></center></th>',
                    '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-_excl_zspin bpmote-hooty"></a><br><center><code>-!zspin</code></center></th>',
                    '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-wobble bpmote-hooty"></a><br><center><code>-wobble</code></center></th>',
                    '<th class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-intensifies bpmote-hooty"></a><br><center><code>-intensifies</code></center></th>',
                 '</tr>',
                 '</table></center><br>',
                 '<center>Sliding:</center>',
                  '<center><table class="bpflagtable">',
                      '<tr><th style="table-layout:fixed;width:350px;" class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-slide bpmote-gus"></a><br><center><code>-slide</code></center></th></tr>',
                      '<tr><th style="table-layout:fixed;width:350px;" class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-_excl_slide bpmote-gus"></a><br><center><code>-!slide</code></center></th></tr>',
                      '<tr><th style="table-layout:fixed;width:350px;" class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-shift bpmote-gus"></a><br><center><code>-shift</code></center></th></tr>',
                      '<tr><th style="table-layout:fixed;width:350px;" class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-_excl_shift bpmote-gus"></a><br><center><code>-!shift</code></center></th></tr>',
                  '</table></center><br>',
                  '<center>Text (use with <code class="bpm-sb-noconvert-txt"></code>):</center>',
                   '<center><table class="bpflagtable">',
                     '<tr>',
                       '<th class="bpflagtable-031e"><center><a style="color:black" class="bpm-emote bpmote-txt_excl bpflag-blink_excl_">yay.</a></center><br><center><code>-blink!</code></center></th>',
                       '<th class="bpflagtable-031e"><center><a style="color:black" class="bpm-emote bpmote-txt_excl bpflag-comicsans_excl_">yay.</a></center><br><center><code>-comicsans!</code></center></th>',
                       '<th class="bpflagtable-031e"><center><a style="color:black" class="bpm-emote bpmote-txt_excl bpflag-impact_excl_">yay.</a></center><br><center><code>-impact!</code></center></th>',
                       '<th class="bpflagtable-031e"><center><a style="color:black" class="bpm-emote bpmote-txt_excl bpflag-tahoma_excl_">yay.</a></center><br><center><code>-tahoma!</code></center></th>',
                       '<th class="bpflagtable-031e"><center><a style="color:black" class="bpm-emote bpmote-txt_excl bpflag-papyrus_excl_">yay.</a></center><br><center><code>-papyrus!</code></center></th>',
                       '<th class="bpflagtable-031e"><center><a style="color:black" class="bpm-emote bpmote-txt_excl bpflag-center">yay.</a></center><br><center><code>-center</code></center></th>',
                       '</tr>',
                   '</table></center><br>',
                   '<br><a class="bpm-emote bpflag-spin bpflag-s1 bpmote-zecora"></a><p class="bpm-sb-flag">Intensity and speed modifiers allow you to modify how flags work and appear. For example, <code class="bpm-sb-noconvert-zecora"></code> would make the emote spin very fast (see left).<br>The examples below demonstrate the least and most intense of the modification flags.</p>',
                   '<br><br><center>Intensity/Speed Modifiers:</center>',
                    '<center><table class="bpflagtable">',
                        '<tr><th style="table-layout:fixed;width:350px;" class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-s1 bpflag-slide bpmote-owlbert"></a><br><center><code>-s1 and -slide</code></center></th></tr>',
                        '<tr><th style="table-layout:fixed;width:350px;" class="bpflagtable-031e"><a class="bpm-emote bpflag-in bpflag-s15 bpflag-_excl_slide bpmote-owlbert"></a><br><center><code>-s15 and -slide</code></center></th></tr>',
                        '</table><table class="bpflagtable"><tr><th style="table-layout:fixed;width:170px;" class="bpflagtable-031e"><center><a class="bpm-emote bpflag-in bpflag-blur1 bpmote-owlbert"></a></center><br><center><code>-blur1</code></center></th>',
                        '<th style="table-layout:fixed;width:170px;" class="bpflagtable-031e"><center><a class="bpm-emote bpflag-in bpflag-blur8 bpmote-owlbert"></a></center><br><center><code>-blur8</code></center></th></tr>',
                    '</table></center><br>',
            '</div>',
          '</div>',
          '<div id="bpm-sb-bottomrow">',
            '<a id="bpm-sb-helplink" href="javascript:void(0)">search help</a> | ',
            '<a id="bpm-sb-flaglink" href="javascript:void(0)">flags help</a> | ',
            '<a id="bpm-sb-optionslink" href="javascript:void(0)">bpm options</a>',
            '<span id="bpm-sb-resize"></span>',
            '<a id="bpm-sb-srlink" href="https://www.reddit.com/r/roleplaydisneytv">/r/roleplaydisneytv</a>',
          '</div>',
        '</div>',
        '<div id="bpm-global-icon" title="Hold Ctrl (Command/Meta) to drag"></div>'
        ].join("");
    div[IHTML] = html;
    document.body.appendChild(div);

    // This seems to me a rather lousy way to build HTML, but oh well
    sb_container = document.getElementById("bpm-sb-container");
    sb_dragbox = document.getElementById("bpm-sb-dragbox");
    sb_input = document.getElementById("bpm-sb-input");
    sb_tagdropdown = document.getElementById("bpm-sb-tagdropdown");
    sb_resultinfo = document.getElementById("bpm-sb-resultinfo");
    sb_close = document.getElementById("bpm-sb-close");
    sb_tabframe = document.getElementById("bpm-sb-tabframe");
    sb_results = document.getElementById("bpm-sb-results");
    sb_helptab = document.getElementById("bpm-sb-helptab");
    sb_helplink = document.getElementById("bpm-sb-helplink");
    sb_flagtab = document.getElementById("bpm-sb-flagtab");
    sb_flaglink = document.getElementById("bpm-sb-flaglink");
    sb_optionslink = document.getElementById("bpm-sb-optionslink");
    sb_resize = document.getElementById("bpm-sb-resize");

    sb_global_icon = document.getElementById("bpm-global-icon");

    if(is_compact) {
        sb_container.classList.add("bpm-compact");
    }
}

/*
 * Sets up the emote search box.
 */
function init_search_ui(store) {
    current_sb_tab = sb_results;

    /*
     * Intercept mouse over for the entire search widget, so we can remember
     * which form was being used before.
     */
    sb_container.addEventListener("mouse" + "over", catch_errors(function(event) {
        track_focus();
    }), false);

    // Close it on demand
    sb_close.addEventListener("click", catch_errors(function(event) {
        hide_search_box();
    }), false);

    // Another way to close it
    sb_container.addEventListener("keyup", catch_errors(function(event) {
        if(event.keyCode === 27) { // Escape key
            hide_search_box();
        }
    }), false);

    // Default behavior of the escape key in the search input is to clear
    // it, which we don't want.
    sb_input.addEventListener("keydown", catch_errors(function(event) {
        if(event.keyCode === 27) { // Escape key
            event.preventDefault();
        }
    }), false);

    // Listen for keypresses and adjust search results. Delay 500ms after
    // end of typing to make it more responsive.
    var timeout = null;
    sb_input.addEventListener("input", catch_errors(function(event) {
        if(timeout !== null) {
            clearTimeout(timeout);
        }
        timeout = ST(catch_errors(function() {
            // Re-enable searching as early as we can, just in case
            timeout = null;
            update_search_results(store);
        }), 500);
    }), false);

    // Listen for clicks
    sb_results.addEventListener("click", catch_errors(function(event) {
        if(event.target.classList.contains("bpm-search-result")) {
            // .dataset would probably be nicer, but just in case...
            var emote_name = event.target.getAttribute("data-emote");
            inject_emote(store, emote_name);
            // On compact display, we want to get out of the way as soon as
            // possible. (Might want to default to this on standard display too,
            // but we're not so offensively invasive there.)
            if(is_compact) {
                hide_search_box();
            }
        }
    }), false);

    // Listen for the "help" tab link
    sb_helplink.addEventListener("click", catch_errors(function(event) {
        if(current_sb_tab !== sb_helptab) {
            switch_to_sb_tab(sb_helptab);
        } else {
            switch_to_sb_tab(sb_results);
        }
    }), false);

    // Listen for the "flag" tab link
    sb_flaglink.addEventListener("click", catch_errors(function(event) {
        if(current_sb_tab !== sb_flagtab) {
            switch_to_sb_tab(sb_flagtab);
        } else {
            switch_to_sb_tab(sb_results);
        }
    }), false);

    // Set up the options page link
    linkify_options(sb_optionslink);

    // Focusing input switches to results tab
    sb_input.addEventListener("focus", catch_errors(function(event) {
        switch_to_sb_tab(sb_results);
    }), false);

    // Set up default positions. NOTE: The container size we set doesn't matter
    // in compact mode. As soon as we open the box, it goes fullscreen anyway.
    var sizeinfo = store.prefs.searchBoxInfo;
    if(is_compact) {
        set_sb_position(0, 0);
    } else {
        set_sb_position(sizeinfo[0], sizeinfo[1]);
        set_sb_size(sizeinfo[2], sizeinfo[3]);
    }
    sb_global_icon.style.left = store.prefs.globalIconPos[0] + "px";
    sb_global_icon.style.top = store.prefs.globalIconPos[1] + "px";

    // Enable dragging the window around
    make_movable(sb_dragbox, sb_container, function(event, left, top, move) {
        move();
        store.prefs.searchBoxInfo[0] = left;
        store.prefs.searchBoxInfo[1] = top;
        store.sync_key("searchBoxInfo");
    });

    // Keep the searchbox on the window
    keep_on_window(sb_container);

    window.addEventListener("resize", catch_errors(function(event) {
        keep_on_window(sb_container);
    }), false);

    // Enable dragging the resize element around (i.e. resizing it)
    var search_box_width, search_box_height;
    enable_drag(sb_resize, function(event) {
        search_box_width = parseInt(sb_container.style.width ? sb_container.style.width : 620, 10);
        search_box_height = parseInt(sb_container.style.height ? sb_container.style.height : 450, 10);
    }, function(event, dx, dy) {
        // 420px wide prevents the search box from collapsing too much, and
        // the extra 5px is to prevent the results div from vanishing (which
        // sometimes kills Opera),
        var sb_width = Math.max(dx + search_box_width, 420);
        var sb_height = Math.max(dy + search_box_height, 62+5);

        set_sb_size(sb_width, sb_height);

        store.prefs.searchBoxInfo[2] = sb_width;
        store.prefs.searchBoxInfo[3] = sb_height;
        store.sync_key("searchBoxInfo");
    });

    // Set up the tag dropdown menu
    var option = document.createElement("option");
    option.value = "";
    option.text = "Tags";
    option.setAttribute("selected", null);
    sb_tagdropdown.add(option);
    for (var id in store._tag_array) {
        var option = document.createElement("option");
        option.value = store._tag_array[id];
        option.text = option.value.substring(1);
        sb_tagdropdown.add(option);
    }
    sb_tagdropdown.onchange = function(){
        sb_input.value = sb_input.value + " " + sb_tagdropdown.value;
        sb_tagdropdown.selectedIndex = "0"
        update_search_results(store);
    };

    // If used on Voat, add the CSS classes for either Light or Dark mode,
    // making use of the native bootstrap classes where apropriate.
    if (is_voat) {
        sb_input.classList.add("form-control");
        if (document.body.classList.contains("dark")) {
            sb_container.classList.add("bpm-dark");
            sb_tabframe.classList.add("bpm-dark");
        }
    }

    // If used on Reddit, and RES enables nightmode, change the theme
    // of BPM accordingly, similarly to how it is with Voat.
    if (is_reddit) {
        if (document.body.classList.contains("res-nightmode")) {
            sb_container.classList.add("bpm-dark");
            sb_tabframe.classList.add("bpm-dark");
        }
    }
}

function set_sb_position(left, top) {
    sb_container.style.left = left + "px";
    sb_container.style.top = top + "px";
}

function set_sb_size(width, height) {
    // 12 and 7 are compensation for container margins/border/padding. Source
    // values are hardcoded in CSS.
    sb_container.style.width = (width - 12) + "px";
    sb_container.style.height = (height - 7) + "px";
    // 62: compensation for top row, bottom row, and various margins (inc.
    // padding of tabframe itself).
    sb_tabframe.style.height = (height - 70) + "px";
    if(is_compact) {
        // 61: width of top row minus close button and various margins (results
        // text and dragbox are not present). Take up all remaining space.
        sb_input.style.width = (width - 61) + "px";
    }
}

/*
 * Initializes the global ">>" emotes icon.
 */
function setup_global_icon(store) {
    log_debug("Injecting global search icon");
    sb_global_icon.addEventListener("mouse" + "over", catch_errors(function(event) {
        track_focus();
    }), false);

    // Enable dragging the global button around
    make_movable(sb_global_icon, sb_global_icon, function(event, left, top, move) {
        if(!event.ctrlKey && !event.metaKey) {
            return;
        }
        move();
        store.prefs.globalIconPos[0] = left;
        store.prefs.globalIconPos[1] = top;
        store.sync_key("globalIconPos");
    });

    sb_global_icon.style.visibility = "visible";

    sb_global_icon.addEventListener("click", catch_errors(function(event) {
        // Don't open at the end of a drag (only works if you release the
        // mouse button before the ctrl/meta key though...)
        if(!event.ctrlKey && !event.metaKey) {
            show_search_box(store);
        }
    }), false);
}

/*
 * Displays the search box.
 */
function show_search_box(store) {
    sb_container.style.visibility = "visible";
    sb_input.focus();
    switch_to_sb_tab(sb_results);

    if(is_compact) {
        // In compact mode, we force it to be fullscreen. We do that here in
        // case the size has changed since last time (i.e. on page load, a
        // scrollbar will appear).
        set_sb_size(document.documentElement.clientWidth, document.documentElement.clientHeight);
    }

    // If we haven't run before, go search for things
    if(!sb_firstrun) {
        sb_firstrun = true;
        sb_input.value = store.prefs.lastSearchQuery;
        update_search_results(store);
    }
}

function hide_search_box() {
    sb_container.style.visibility = "hidden";
    sb_flagtab.style.display = "none"; //Needed to make the "flags help" tab a) not lag when unused and b) display properly.
    // TODO: possibly clear out the search results, since it's a large pile
    // of HTML.
    if(target_form) {
        target_form.focus();
    }
}

function switch_to_sb_tab(tab) {
    var tabs = [sb_results, sb_helptab, sb_flagtab];
    for(var i = 0; i < tabs.length; i++) {
        tabs[i].style.display = "none";
    }
    tab.style.display = "block";
    current_sb_tab = tab;
}

/*
 * Updates the search results window according to the current query.
 */
function update_search_results(store) {
    // Split search query on spaces, remove empty strings, and lowercase terms
    var terms = sb_input.value.split(" ").map(function(v) { return v.toLowerCase(); });
    terms = terms.filter(function(v) { return v; });
    store.prefs.lastSearchQuery = terms.join(" ");
    store.sync_key("lastSearchQuery");

    // Check this before we append the default search terms.
    if(!terms.length) {
        // If we're on a subreddit that has some of its own emotes, show those
        // instead of nothing.
        if(current_subreddit && bpm_data.sr_name2id[current_subreddit] !== undefined) {
            terms = [current_subreddit];
        } else {
            sb_results[IHTML] = "";
            sb_resultinfo.textContent = "";
            return;
        }
    }

    // This doesn't work quite perfectly- searching for "+hidden" should
    // theoretically just show all hidden emotes, but it just ends up
    // cancelling into "-nonpony", searching for everything.
    terms.unshift("-hidden", "-nonpony");
    var query = parse_search_query(terms);
    // Still nothing to do
    if(query === null) {
        sb_results[IHTML] = "";
        sb_resultinfo.textContent = "";
        return;
    }

    var results = execute_search(store, query);
    log_debug("Search found", results.length, "results on query", query);
    display_search_results(store, results);
}

/*
 * Converts search results to HTML and displays them.
 */
function display_search_results(store, results) {
    // We go through all of the results regardless of search limit (as that
    // doesn't take very long), but stop building HTML when we reach enough
    // shown emotes.
    //
    // As a result, NSFW/disabled emotes don't count toward the result.
    var html = "";
    var shown = 0;
    var hidden = 0;
    var prev = null;
    var actual_results = results.length;
    for(var i = 0; i < results.length; i++) {
        var result = results[i];
        if(prev === result.name) {
            actual_results--;
            continue; // Duplicates can appear when following +v emotes
        }
        prev = result.name;

        if(store.is_disabled(result)) {
            // TODO: enable it anyway if a pref is set? Dunno exactly what
            // we'd do
            hidden += 1;
            continue;
        }

        if(shown >= store.prefs.searchLimit) {
            continue;
        } else {
            shown += 1;
        }

        // Use <span> so there's no chance of emote parse code finding
        // this.
        html += "<span data-emote=\"" + result.name + "\" class=\"bpm-search-result bpm-emote " +
                result.css_class + "\" title=\"" + result.name + " from " + result.source_name + "\">";
        if(result.tags.indexOf(store.formatting_tag_id) > -1) {
            html += "Example Text";
        }
        html += "</span>";
    }

    sb_results[IHTML] = html;

    var hit_limit = shown + hidden < actual_results;
    // Format text: "X results (out of N, Y hidden)"
    var text = shown + " results";
    if(hit_limit || hidden) { text += " ("; }
    if(hit_limit)           { text += "out of " + actual_results; }
    if(hit_limit && hidden) { text += ", "; }
    if(hidden)              { text += hidden + " hidden"; }
    if(hit_limit || hidden) { text += ")"; }
    sb_resultinfo.textContent = text;
}

/*
 * Injects the "emotes" button onto Reddit.
 */
function inject_emotes_button(store, usertext_edits) {
    for(var i = 0; i < usertext_edits.length; i++) {
        var existing = usertext_edits[i].getElementsByClassName("bpm-search-toggle");
        var textarea = usertext_edits[i].getElementsByTagName("textarea")[0];
        /*
         * Reddit's JS uses cloneNode() when making reply forms. As such,
         * we need to be able to handle two distinct cases- wiring up the
         * top-level reply box that's there from the start, and wiring up
         * clones of that form with our button already in it.
         */
        if(existing.length) {
            wire_emotes_button(store, existing[0], textarea);
        } else {
            var button = document.createElement("button");
            // Default is "submit", which is not good (saves the comment).
            // Safari has some extremely weird bug where button.type seems to
            // be readonly. Writes fail silently.
            button.setAttribute("type", "button");
            button.classList.add("bpm-search-toggle");
            if(is_compact) {
                // Blend in with the other mobile buttons
                button.classList.add("newbutton");
            } else if(is_modreddit) {
                // Blend in with the other modmail buttons
                button.classList.add("Button");
            } else if(is_voat) {
                button.classList.add("markdownEditorImgButton");
                button.classList.add("bpm-voat");
            }
            button.textContent = "emotes";
            // Since we come before the save button in the DOM, we tab first,
            // but this is generally annoying. Correcting this ideally would
            // require moving or editing the save button, which I'd rather not
            // do.
            //
            // So instead it's just untabbable.
            button.tabIndex = 100;
            wire_emotes_button(store, button, textarea);
            // On the standard display, we want the emotes button to be all the
            // way to the right, next to the "formatting help" link. However,
            // this breaks rather badly on .compact display (sort of merging
            // into it), so do something different there.
            // If in modmail, have it on the left instead.
            // If on voat, do something completely different.
            if (is_reddit) {
                if(is_compact) {
                    var button_bar = find_class(usertext_edits[i], "usertext-buttons");
                    button_bar.insertBefore(button, find_class(button_bar, "status"));
                } else {
                    var bottom_area = find_class(usertext_edits[i], "bottom-area");
                    bottom_area.insertBefore(button, bottom_area.firstChild);
                }
            } else if (is_modreddit) {
                if (ends_with(document.location.pathname, "create")) {
                    var button_bar = find_class(usertext_edits[i], "NewThread__submitRow");
                    button_bar.insertBefore(button, find_class(button_bar, "NewThread__formattingHelp"));
                } else {
                    var button_bar = find_class(usertext_edits[i], "ThreadViewerReplyForm__replyFooter");
                    button_bar.insertBefore(button, find_class(button_bar, "ThreadViewerReplyForm__formattingHelp"));
                }
            } else if (is_voat) {
                var editbar = find_class(usertext_edits[i], "markdownEditorMainMenu");
                editbar.appendChild(button);
            }
        }
    }
}

/*
 * Sets up one particular "emotes" button.
 */
function wire_emotes_button(store, button, textarea) {
    button.addEventListener("mouse" + "over", catch_errors(function(event) {
        track_focus();
    }), false);

    button.addEventListener("click", catch_errors(function(event) {
        if(sb_container.style.visibility !== "visible") {
            show_search_box(store);
            if(!target_form) {
                target_form = textarea;
            }
        } else {
            hide_search_box();
        }
    }), false);
}
/*
 * Sets up search for use in a frame. No search box is generated, but it
 * listens for postMessage() calls from the parent frame.
 */
function init_frame_search(store) {
    log_debug("Setting frame message hook");
    window.addEventListener("message", catch_errors(function(event) {
        // Not worried about event source (it might be null in Firefox, as
        // a note). Both of these methods are quite harmless, so it's
        // probably ok to let them be publically abusable.
        //
        // I'm not sure how else we can do it, anyway- possibly by going
        // through the backend, but not in userscripts. (Maybe we can abuse
        // GM_setValue().)
        var message = event.data;
        switch(message.__betterredditmotes_method) {
            case "__bpm_inject_emote":
                // Call toString() just in case
                inject_emote(store, message.__betterredditmotes_emote.toString());
                break;

            case "__bpm_track_focus":
                track_focus();
                break;

            // If it's not our message, it'll be undefined. (We don't care.)
        }
    }), false);
}
// Known spoiler "emotes" to avoid expanding alt-text on. Not all of these are
// known to BPM, and it's not really worth moving this to a data file somewhere.
// - /spoiler is from r/mylittlepony (and copied around like mad)
// - /s is from r/falloutequestria (and r/mylittleanime has a variant)
// - #s is from r/doctorwho
// - /b and /g are from r/dresdenfiles
var spoiler_links = [
    "/spoiler", // r/mylittlepony and many other subreddits
    "/s",       // r/falloutequestria, and a variant in r/mylittleanime
    "/g",       // r/dresdenfiles
    "/b",       // r/dresdenfiles
    "#s",       // r/doctorwho and r/gameofthrones
    "#g",       // r/gameofthrones
    "#b",       // r/gameofthrones
    "/a",       // r/ShingekiNoKyojin
    "/m",       // r/ShingekiNoKyojin
    "/t",       // r/ShingekiNoKyojin
    "#spoiler", // r/gravityfalls
    "#fg",      // r/LearnJapanese
    ];

/*
 * Sets the sourceinfo hover on an emote element.
 */
function add_sourceinfo(element, state, is_emote, is_unknown) {
    var name = element.getAttribute("href");
    var title = "";

    if(is_emote) {
        var subreddit = element.getAttribute("data-bpm_srname");

        if(state.indexOf("d") > -1) {
            title = "Disabled ";
            if(state.indexOf("n") > -1) {
                title += "NSFW ";
            }
            title += "emote ";
        }
        title += name + " from " + subreddit;
    } else if(is_unknown) {
        title = "Unknown emote " + name;
    }

    element.title = title;
}

/*
 * Decides whether or not the alt-text on this element needs to be processed.
 * Returns bpm_state if yes, null if no.
 */
function should_convert_alt_text(element, state, is_emote) {
    // Already processed? Avoid doing silly things like expanding things again
    // (or our sourceinfo hover)
    if(state.indexOf("a") > -1) {
        return false;
    }

    // Avoid spoiler links. We can't rely on any emote data to exist, as
    // of them aren't known as emotes
    var href = element.getAttribute("href");
    if(href && spoiler_links.indexOf(href.split("-")[0]) > -1) {
        return false;
    }

    if(is_emote) {
        // Emotes require a sourceinfo hover, no matter what
        return true;
    }

    if(!element.title) {
        // Note, we don't bother setting state="a" in this case
        return false;
    }

    // Work around RES putting tag links and other things with alt-text on
    // them in the middle of posts- we don't want to expand those.
    if(element.classList.contains("userTagLink") ||
       element.classList.contains("voteWeight") ||
       element.classList.contains("expando-button")) {
        return false;
    }

    return true;
}

/*
 * Generates the actual alt-text element. Handles embedded links.
 */
function generate_alt_text(title, container) {
    // Split on links, so we can turn those into real links. These are rare,
    // but worth handling nicely. Also prepend a space for formatting- it makes
    // the most difference on non-emote elements.
    // (\b doesn't seem to be working when I put it at the end, here??
    // Also, note that we do grab the space at the end for formatting)
    //                                  http://    < domain name >    /url?params#stuff
    var parts = (" " + title).split(/\b(https?:\/\/[a-zA-Z0-9\-.]+(?:\/[a-zA-Z0-9\-_.~'();:+\/?%#]*)?(?:\s|$))/);

    // Handle items in pairs: one chunk of text and one link at a time
    for(var j = 0; j < Math.floor(parts.length / 2); j += 2) {
        if(parts[j]) {
            container.appendChild(document.createTextNode(parts[j]));
        }
        var link_element = document.createElement("a");
        link_element.textContent = parts[j + 1];
        link_element.href = parts[j + 1];
        container.appendChild(link_element);
    }

    // The last bit is just text. (And likely the only chunk there is, anyway.)
    if(parts[parts.length - 1]) {
        container.appendChild(document.createTextNode(parts[parts.length - 1]));
    }
}

function convert_alt_text(element, is_emote, is_unknown) {
    // If this is an image link, try to put the alt-text on the other side
    // of the RES expando button. It looks better that way.
    var before = element.nextSibling; // Thing to put alt-text before
    while(before && before.className !== undefined &&
          before.classList.contains("expando-button")) {
        before = before.nextSibling;
    }

    // As a note: alt-text kinda has to be a block-level element, in order
    // to go in the same place as the emote it's attached to. The chief
    // exception is -in emotes, so as a bit of a hack, we assume the
    // converter has already run and check for known -in flags. The other
    // possibility is that this is just a normal link of some kind, so
    // treat those as special too.
    var element_type = "div";
    if(element.classList.contains("bpflag-in") ||
       element.classList.contains("bpflag-inp") ||
       (!is_emote && !is_unknown)) {
        element_type = "span";
    }

    // Do the actual conversion
    var container = document.createElement(element_type);
    container.classList.add("bpm-alttext");
    generate_alt_text(element.title, container);
    element.parentNode.insertBefore(container, before);
}

/*
 * Converts alt-text on an <a> element as appropriate. Will respond to the emote
 * converter if it has already run on this element.
 */
function process_alt_text(element) {
    var state = element.getAttribute("data-bpm_state") || "";
    var is_emote = state.indexOf("e") > -1;
    var is_unknown = state.indexOf("u") > -1;

    // Early exit- some elements we just ignore completely
    if(!should_convert_alt_text(element, state, is_emote)) {
        return;
    }

    // Actual alt-text conversion
    if(element.title) {
        convert_alt_text(element, is_emote, is_unknown);
    }

    // Special support for emotes- replace the alt-text with source info
    if(is_emote || is_unknown) {
        add_sourceinfo(element, state, is_emote, is_unknown);
    }

    // Mark as handled, so we don't ever run into it again.
    element.setAttribute("data-bpm_state", state + "a");
}
/*
 * Adds emote flags to an element.
 */
function add_flags(element, parts) {
    for(var p = 1; p < parts.length; p++) {
        // Normalize case, and forbid things that don't look exactly as we expect
        var flag = parts[p].toLowerCase();
        if(/^[\w:!#\/]+$/.test(flag)) {
            element.classList.add("bpflag-" + sanitize_emote(flag));
        }
    }
}

/*
 * Removes all flags from an emote.
 */
function strip_flags(element) {
    for(var i = 0; i < element.classList.length; i++) {
        var name = element.classList[i];
        if(starts_with(name, "bpflag-")) {
            element.classList.remove(name);
            i--; // Sure hope this works
        }
    }
}

/*
 * Mangle a recognized <a> element to be an emote. Applies all CSS, state, and
 * flags. Handles disabled emotes.
 */
function convert_emote_element(store, element, parts, name, info) {
    // Applied to all emote elements, no matter what
    element.classList.add("bpm-emote");

    // Attributes used in alt-text, to avoid extra lookups.
    element.setAttribute("data-bpm_emotename", name);
    element.setAttribute("data-bpm_srname", info.source_name);

    // Leave existing text alone. This is also relevant to the click toggle
    // and the alt-text converter, so record this fact for later use
    var can_modify_text = !element.textContent;
    var disabled = store.is_disabled(info);

    // Work out state variable. "e" is always present
    var state = "e";
    if(info.is_nsfw) {
        state += "n";
    }
    if(can_modify_text) {
        state += "T";
    }
    if(disabled) {
        state += "d" + disabled; // Add numerical code (only 1=NSFW is used)
    }
    element.setAttribute("data-bpm_state", state);

    if(disabled || (store.prefs.stealthMode && info.tags.indexOf(store.formatting_tag_id) < 0)) {
        if(can_modify_text) {
            // Any existing text (generally, there shouldn't be any) will look
            // a little funny with our custom CSS, but there's not much we can
            // do about that.
            element.textContent = name;
        }

        // Combining these two prefs makes absolutely no sense, but try to do
        // something sane anyway
        if(store.prefs.hideDisabledEmotes && !store.prefs.stealthMode) {
            // "Ignore" mode- don't minify it, just hide it completely
            element.classList.add("bpm-hidden");
        } else {
            element.classList.add("bpm-minified"); // Minify emote
            if(disabled === 1) {
                // NSFW emotes have a special look to them
                element.classList.add("bpm-nsfw");
            }
        }

        return;
    }

    // Apply the actual emote CSS
    element.classList.add(info.css_class);

    // Apply flags
    add_flags(element, parts);
}

/*
 * Inspects an element to decide whether or not it appears to be a broken emote.
 */
function is_broken_emote(element, name) {
    /*
     * If there's:
     *    1) No text
     *    2) href matches regexp (no slashes, mainly)
     *    3) No size (missing bg image means it won't display)
     *    4) No :after or :before tricks to display the image (some subreddits
     *       do emotes with those selectors)
     * Then it's probably an emote, but we don't know what it is. Thanks to
     * nallar for his advice/code here.
     */
    // Cheap tests first
    if(element.textContent || !(/^\#[\w\-:!]+$/).test(name) || element.clientWidth) { //DALEK CHANGE
        return false;
    }

    // Check for presence of background-image, also on :after and :before
    var pseudos = [null, ":after", ":before"];
    for(var pi = 0; pi < pseudos.length; pi++) {
        var bg_image = window.getComputedStyle(element, pseudos[pi]).backgroundImage;
        // This value is "" in Opera, but "none" in Firefox and Chrome.
        if(bg_image && bg_image !== "none") {
            return false;
        }
    }

    return true; // Good enough
}

/*
 * Mangles an element that appears to be an unknown emote.
 */
function convert_broken_emote(element, name) {
    // Unknown emote? Good enough
    element.setAttribute("data-bpm_state", "u");
    element.setAttribute("data-bpm_emotename", name);
    element.classList.add("bpm-minified");
    element.classList.add("bpm-unknown");

    var can_modify_text = !element.textContent;
    if(can_modify_text) {
        element.textContent = name;
    }
}

/*
 * Does any relevant processing on an <a> element, converting emotes where
 * possible.
 */
function process_element(store, element, convert_unknown) {
    // Already been handled for some reason?
    if(element.classList.contains("bpm-emote") ||
       element.classList.contains("bpm-unknown")) {
        return;
    }

    // There is an important distinction between element.href and the raw
    // attribute: the former is mangled by the browser, which we don't want.
    var href = element.getAttribute("href");

    if(href && href[0] === "#") {   //DALEK CHANGE
        // Don't normalize case for emote lookup- they are case sensitive
        var parts = href.split("-");
        var name = parts[0];
        var info = store.lookup_emote(name, true);

        if(info) {
            // Found an emote
            convert_emote_element(store, element, parts, name, info);
        } else if(convert_unknown && store.prefs.showUnknownEmotes) {
            // Does it look like something meant to be an emote?
            if(is_broken_emote(element, name)) {
                convert_broken_emote(element, name);
            }
        }
    }
}

var _sidebar_cache = null;
function is_sidebar(md) {
    if(_sidebar_cache) {
        return _sidebar_cache === md;
    }
    var is = class_above(md, "titlebox");
    if(is) {
        _sidebar_cache = md;
    }
    return Boolean(is);
}

/*
 * Processes emotes and alt-text under an element, given the containing .md.
 */
function process_post(store, post, md, expand_emotes) {
    // Generally, the first post on the page will be the sidebar, so this
    // is an extremely fast test.
    var sidebar = is_sidebar(md);
    var links = slice(post.getElementsByTagName("a"));
    for(var i = 0; i < links.length; i++) {
        var element = links[i];
        if(expand_emotes) {
            process_element(store, element, !sidebar);
        }
        // NOTE: must run alt-text AFTER emote code, always. See note in
        // process_alt_text
        if(!sidebar && store.prefs.showAltText) {
            process_alt_text(element);
        }
    }
}
var current_subreddit = (function() {
    // FIXME: what other characters are valid?
    var match = document.location.href.match(/reddit\.com\/(r\/[\w]+)/);
    if(match) {
        return match[1].toLowerCase();
    } else {
        return null;
    }
})();

function is_blacklisted(store) {
    return !!store.prefs.blacklistedSubreddits[current_subreddit];
}

/*
 * Injects a sneaky little link at the bottom of each Reddit page that
 * displays the logs.
 */
function inject_buttons(store) {
    function add_link(container, text, callback) {
        var link = document.createElement("a");
        link.href = "javascript:void(0)";
        link.textContent = text;
        container.appendChild(link);
        link.addEventListener("click", catch_errors(callback), false);
        return link;
    }

    var reddit_footer = find_class(document.body, "footer-parent");
    if(!reddit_footer) {
        return;
    }

    // <div><pre>...</pre> <a>[dump bpm logs]</a></div>
    var container = document.createElement("div");
    container.className = "bottommenu";
    reddit_footer.appendChild(container);

    var output = document.createElement("pre");
    output.style.display = "none";
    output.style.textAlign = "left";
    output.style.borderStyle = "solid";
    output.style.width = "50%";
    output.style.margin = "auto auto auto auto";

    // Log link
    add_link(container, "[dump bpm logs] ", function(event) {
        output.style.display = "block";
        var logs = _log_buffer.join("\n");
        output.textContent = logs;
    });
    container.appendChild(output);

    // Subreddit blacklist control. This isn't available from the prefs page
    function bl_text() {
        return "[" + (is_blacklisted(store) ? "whitelist" : "blacklist") + " subreddit]";
    }

    var bl_link = add_link(container, bl_text(), function(event) {
        if(is_blacklisted(store)) {
            delete store.prefs.blacklistedSubreddits[current_subreddit];
        } else {
            store.prefs.blacklistedSubreddits[current_subreddit] = true;
        }
        store.sync_key("blacklistedSubreddits")
        bl_link.textContent = bl_text();
    });
}

function toggle_emote(store, element) {
    // Click toggle
    var state = element.getAttribute("data-bpm_state") || "";
    var is_nsfw_disabled = state.indexOf("1") > -1; // NSFW
    if(store.prefs.clickToggleSFW && is_nsfw_disabled) {
        return;
    }
    var info = store.lookup_emote(element.getAttribute("data-bpm_emotename"), false);
    if(element.classList.contains("bpm-minified")) {
        // Show: unminify, enable, give it its CSS, remove the bit of text we
        // added, enable flags.
        element.classList.remove("bpm-minified");
        element.classList.remove("bpm-nsfw");
        element.classList.add(info.css_class);
        if(state.indexOf("T") > -1) {
            element.textContent = "";
        }
        var parts = element.getAttribute("href").split("-");
        add_flags(element, parts);
    } else {
        // Hide: remove its CSS, minify, optionally disable, put our bit of
        // text back, and kill flags.
        element.classList.remove(info.css_class);
        element.classList.add("bpm-minified");
        if(is_nsfw_disabled) {
            element.classList.add("bpm-nsfw");
        }
        if(state.indexOf("T") > -1) {
            element.textContent = element.getAttribute("href");
        }
        strip_flags(element);
    }
}

function block_click(store, event) {
    var element = event.target;

    // Go up a level or two to see if one of the parent nodes is an emote. This
    // improves behavior on the "text" emotes e.g. e.g. [*Free hugs*](/lpsign).
    //
    // We somewhat arbitrarily only go up one element here. That should be
    // enough for our purposes, and keeps this particular check short and fast.
    for(var tries = 0; element && tries < 2; tries++) {
        if(element.classList.contains("bpm-emote")) {
            event.preventDefault();
            toggle_emote(store, element);
            break;
        } else if(element.classList.contains("bpm-unknown")) {
            event.preventDefault();
            break;
        }

        element = element.parentElement;
    }
}

/*
 * Main function when running on Reddit or Voat.
 */
function run_reddit(store, expand_emotes) {
    init_search_box(store);
    if (is_reddit) {
        var usertext_edits = slice(document.getElementsByClassName("usertext-edit"));
    } else if (is_modreddit) {
        if (ends_with(document.location.pathname, "create")) {
            var usertext_edits = slice(document.getElementsByClassName("NewThread__form"));
        } else {
            var usertext_edits = slice(document.getElementsByClassName("ThreadViewer__replyContainer"));
        }
    } else if (is_voat) {
        var usertext_edits = slice(document.getElementsByClassName("markdownEditor"));
    }
    inject_emotes_button(store, usertext_edits);

    // Initial pass- show all emotes currently on the page.
    var posts = slice(document.querySelectorAll(".md, .Post, .Comment"));
    log_debug("Processing", posts.length, "initial posts");
    for(var i = 0; i < posts.length; i++) {
        process_post(store, posts[i], posts[i], expand_emotes);
    }

    // Add emote click blocker
    document.body.addEventListener("click", catch_errors(function(event) {
        block_click(store, event);
    }), false);

    // As a relevant note, it's a terrible idea to set this up before
    // the DOM is built, because monitoring it for changes seems to slow
    // the process down horribly.

    // What we do here: for each mutation, inspect every .md we can
    // find- whether the node in question is deep within one, or contains
    // some.
    observe_document(function(nodes) {
        for(var n = 0; n < nodes.length; n++) {
            var root = nodes[n];
            if(root.nodeType !== find_global("Node").ELEMENT_NODE) {
                // Not interested in other kinds of nodes.
                continue;
            }

            var md;
            if(md = class_above(root, "md")) {
                // We're inside of a post- so only handle links underneath here
                process_post(store, root, md, expand_emotes);
            } else {
                // Are there any posts below us?
                var posts = slice(root.querySelectorAll(".md, .Post, .Comment"));
                if(posts.length) {
                    log_debug("Processing", posts.length, "new posts");
                    for(var p = 0; p < posts.length; p++) {
                        process_post(store, posts[p], posts[p], expand_emotes);
                    }
                }
            }

            // TODO: move up in case we're inside it?
            if (is_reddit) {
                var usertext_edits = slice(root.getElementsByClassName("usertext-edit"));
            } else if (is_modreddit) {
                if (ends_with(document.location.pathname, "create")) {
                    var usertext_edits = slice(root.getElementsByClassName("NewThread__form"));
                } else {
                    var usertext_edits = slice(root.getElementsByClassName("ThreadViewer__replyContainer"));
                }
            } else if (is_voat) {
                var usertext_edits = slice(root.getElementsByClassName("markdownEditor"));
            }
            inject_emotes_button(store, usertext_edits);
        }
    });
}

function reddit_main(store) {
    log_info("Running on Reddit");

    init_css(store);
    _checkpoint("css");

    with_dom(function() {
        inject_buttons(store); // Try to do this early
        var expand_emotes = !is_blacklisted(store);
        if(!expand_emotes) {
            log_info("Disabling emote expansion on blacklisted subreddit /r/" + current_subreddit)
        }
        run_reddit(store, expand_emotes);
        _checkpoint("done");
    });
}
/*
 * A fairly reliable indicator as to whether or not BPM is currently
 * running in a frame.
 */
// Firefox is funny about window/.self/.parent/.top, such that comparing
// references is unreliable. frameElement is the only test I've found so
// far that works consistently.
var running_in_frame = (window !== window.top || window.frameElement);

// As a note, this regexp is a little forgiving in some respects and strict in
// others. It will not permit text in the [] portion, but alt-text quotes don't
// have to match each other.
//
//                        <   emote      >   <    alt-text     >
var emote_regexp = /\[\]\((\/[\w:!#\/\-]+)\s*(?:["']([^"]*)["'])?\)/g;

// this!==window on Opera, and doesn't have this object for some reason
var Node = find_global("Node");

function preserve_scroll(node, callback) {
    // Move up through the DOM and see if there's a container element that
    // scrolls, so we can keep track of how the size of its contents change.
    // Also, this is really expensive.
    var container = locate_matching_ancestor(node, function(element) {
        var style = window.getComputedStyle(element);
        if(style && (style.overflowY === "auto" || style.overflowY === "scroll")) {
            return true;
        } else {
            return false;
        }
    });

    if(container) {
        var top = container.scrollTop;
        var height = container.scrollHeight;
        // visible height + amount hidden > total height
        // + 1 just for a bit of safety
        var at_bottom = (container.clientHeight + top + 1 >= height);
    }

    callback();

    // If the parent element has gotten higher due to our emotes, and it was at
    // the bottom before, scroll it down by the delta.
    if(container && at_bottom && top && container.scrollHeight > height) {
        var delta = container.scrollHeight - height;
        container.scrollTop = container.scrollTop + delta;
    }
}

function make_emote(match, parts, name, info) {
    // Build emote. (Global emotes are always -in)
    var element = document.createElement("span");
    element.classList.add("bpflag-in");

    // Some lies for alt-text.
    element.setAttribute("href", match[1]);
    if(match[2]) {
        // Note: the quotes aren't captured by the regexp
        element.title = match[2];
    }

    element.classList.add("bpm-emote");
    element.setAttribute("data-bpm_emotename", name);
    element.setAttribute("data-bpm_srname", info.source_name);
    element.setAttribute("data-bpm_state", "eT"); // TODO: "n" flag

    element.classList.add(info.css_class);
    add_flags(element, parts);

    return element;
}

/*
 * Searches elements recursively for [](#emotes), and converts them.
 */
function process_text(store, root) {
    // List of nodes to delete. Would probably not work well to remove nodes
    // while walking the DOM
    var deletion_list = [];

    var nodes_processed = 0;
    var emotes_matched = 0;

    walk_dom(root, Node.TEXT_NODE, function(node) {
        nodes_processed++;

        var parent = node.parentNode;
        // <span> elements to apply alt-text to
        var emote_elements = [];
        emote_regexp.lastIndex = 0;

        var new_elements = [];
        var end_of_prev = 0; // End index of previous emote match
        var match;

        // Locate every emote we can in this text node. Each time through,
        // append the text before it and our new emote node to new_elements.
        while(match = emote_regexp.exec(node.data)) {
            emotes_matched++;

            // Don't normalize case for emote lookup
            var parts = match[1].split("-");
            var name = parts[0];
            var info = store.lookup_emote(name, false);

            if(info === null) {
                continue;
            }

            if(store.is_disabled(info)) {
                continue;
            }

            // Keep text between the last emote and this one (or the start
            // of the text element)
            var before_text = node.data.slice(end_of_prev, match.index);
            if(before_text) {
                new_elements.push(document.createTextNode(before_text));
            }

            var element = make_emote(match, parts, name, info);

            new_elements.push(element);
            emote_elements.push(element);

            // Next text element will start after this emote
            end_of_prev = match.index + match[0].length;
        }

        // If length == 0, then there were no emote matches to begin with,
        // and we should just leave it alone
        if(new_elements.length) {
            // There were emotes, so grab the last bit of text at the end too
            var end_text = node.data.slice(end_of_prev);
            if(end_text) {
                new_elements.push(document.createTextNode(end_text));
            }

            preserve_scroll(parent, function() {
                // Insert all our new nodes
                for(var i = 0; i < new_elements.length; i++) {
                    parent.insertBefore(new_elements[i], node);
                }

                // Remove original text node. FIXME: since we delay this, are we
                // affecting the scroll-fixing code by resizing stuff later?
                deletion_list.push(node);

                // Convert alt text and such. We want to do this after we insert
                // our new nodes (so that the alt-text element goes to the right
                // place) but before we rescroll.
                if(store.prefs.showAltText) {
                    for(var i = 0; i < emote_elements.length; i++) {
                        process_alt_text(emote_elements[i]);
                    }
                }
            });
        }
    }, function() {
        // Code run after the entire tree has been walked- delete the text
        // nodes that we deferred. FIXME: this is dumb, we should be removing
        // stuff as we go so the scrollfix code works right, and so huge pages
        // behave more sanely (you'll see emotes appear, then MUCH LATER the
        // text disappear).
        if(nodes_processed) {
            log_debug("Processed", nodes_processed, "node(s) and matched", emotes_matched, "emote(s)");
        }
        for(var i = 0; i < deletion_list.length; i++) {
            var node = deletion_list[i];
            node.parentNode.removeChild(node);
        }
    });
}

/*
 * Main function when running globally.
 */
function run_global(store) {
    if(store.prefs.enableGlobalSearch) {
        // Never inject the search box into frames. Too many sites fuck up
        // entirely if we do. Instead, we do some cross-frame communication.
        if(running_in_frame) {
            init_frame_search(store);
        } else {
            init_search_box(store);
            setup_global_icon(store);
        }
    }

    process_text(store, document.body);

    observe_document(function(nodes) {
        for(var i = 0; i < nodes.length; i++) {
            if(nodes[i].nodeType !== Node.ELEMENT_NODE) {
                // Not interested in other kinds of nodes.
                // FIXME: this makes no sense
                continue;
            }
            process_text(store, nodes[i]);
        }
    });
}

function global_main(store) {
    if(!store.prefs.enableGlobalEmotes) {
        return;
    }

    // Check against domain blacklist
    for(var i = 0; i < DOMAIN_BLACKLIST.length; i++) {
        if(document.location.hostname === DOMAIN_BLACKLIST[i] ||
           ends_with(document.location.hostname, DOMAIN_BLACKLIST[i])) {
            log_warning("Refusing to run on '" + document.location.hostname + "': domain is blacklisted (probably broken)");
            return;
        }
    }

    log_info("Running globally");

    init_css(store);
    _checkpoint("css");

    with_dom(function() {
        run_global(store);
        _checkpoint("done");
    });
}
/*
 * Attaches all of our CSS.
 */
function init_css(store) {
    // Most environments permit us to create <link> tags before DOMContentLoaded
    // (though Chrome forces us to use documentElement). Scriptish is one that
    // does not- there's no clear way to manipulate the partial DOM, so we delay.
    with_css_parent(function() {
        log_info("Setting up css");
        link_css("/bpmotes.css");
        link_css("/emote-classes.css");

        if(store.prefs.enableExtraCSS) {
            // Inspect style properties to determine what extracss variant to
            // apply.
            //    Firefox: <16.0 requires -moz, which we don't support
            //    Chrome (WebKit): Always needs -webkit
            var style = document.createElement("span").style;

            if(style.webkitTransform !== undefined) {
                link_css("/extracss-webkit.css");
            } else if(style.transform !== undefined) {
                link_css("/extracss-pure.css");
            } else {
                log_warning("Cannot inspect vendor prefix needed for extracss.");
                // You never know, maybe it'll work
                link_css("/extracss-pure.css");
            }

            if(store.prefs.enableNSFW) {
                link_css("/combiners-nsfw.css");
            }
        }

        if(platform === "chrome-ext") {
            // Fix for Chrome, which sometimes doesn't rerender unknown emote
            // elements. The result is that until the element is "nudged" in
            // some way- merely viewing it in the Console/platform Elements
            // tabs will do- it won't display.
            //
            // RES seems to reliably set things off, but that won't always be
            // installed. Perhaps some day we'll trigger it implicitly through
            // other means and be able to get rid of this, but for now it seems
            // not to matter.
            var tag = document.createElement("style");
            tag.type = "text/css";
            document.head.appendChild(tag);
        }

        add_css(store.custom_css);
    });

    with_dom(function() {
        // Inject our filter SVG for Firefox. Chrome renders this thing as a
        // massive box, but "display: none" (or putting it in <head>) makes
        // Firefox hide all of the emotes we apply the filter to- as if *they*
        // had display:none. Furthermore, "height:0;width:0" isn't quite enough
        // either, as margins or something make the body move down a fair bit
        // (leaving a white gap). "position:fixed" is a workaround for that.
        //
        // We also can't include either the SVG or the CSS as a normal resource
        // because Firefox throws security errors. No idea why.
        //
        // Can't do this before the DOM is built, because we use document.body
        // by necessity.
        //
        // Christ. I hope people use the fuck out of -i after this nonsense.
        if(platform === "firefox-ext") {
            var svg_src = [
                '<svg version="1.1" baseProfile="full" xmlns="http://www.w3.org/2000/svg"',
                ' style="height: 0; width: 0; position: fixed">',
                '  <filter id="bpm-darkle">',
                '    <feColorMatrix in="SourceGraphic" type="hueRotate" values="180"/>',
                '  </filter>',
                '  <filter id="bpm-invert">',
                '    <feColorMatrix in="SourceGraphic" type="matrix" values="',
                '                   -1  0  0 0 1',
                '                    0 -1  0 0 1',
                '                    0  0 -1 0 1',
                '                    0  0  0 1 0"/>',
                '  </filter>',
                '</svg>'
            ].join("\n");
            var div = document.createElement("div");
            div[IHTML] = svg_src;
            document.body.insertBefore(div.firstChild, document.body.firstChild);

            add_css(".bpflag-i { filter: url(#bpm-darkle); }" +
                    ".bpflag-invert { filter: url(#bpm-invert); }");
        }
    });
}

function main() {
    log_info("Starting up");
    setup_browser({"prefs": 1, "customcss": 1}, function(store) {
        if(document.location && document.location.hostname && (is_reddit || is_modreddit || is_voat)) {
            reddit_main(store);
        } else {
            global_main(store);
        }
    });
}

main();

})(this); // Script wrapper
