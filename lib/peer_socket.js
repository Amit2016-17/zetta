var EventEmitter = require('events').EventEmitter;
var util = require('util');
var http = require('http');
var url = require('url');
var querystring = require('querystring');
var spdy = require('spdy');
var ws = require('ws');
var SpdyAgent = require('./spdy_agent');
var Logger = require('./logger');

var STATES = {
  'DISCONNECTED' : 0,
  'CONNECTING': 1,
  'CONNECTED': 2
};

var PeerSocket = module.exports = function(ws, request, name, peerRegistry, opts) {
  EventEmitter.call(this);

  if (!opts) {
    opts = {};
  }
  
  var self = this;
  this.state = STATES.DISCONNECTED;
  this.name = name; // peers local id
  this.agent = null;
  this.subscriptions = {}; // { <topic>: <subscribed_count> }
  this.connectionId = null;
  this._pingTimer = null;
  this._pingTimeout = Number(opts.pingTimeout) || (10 * 1000);
  this._confirmationTimeout = Number(opts.confirmationTimeout) || 10 * 1000;
  this.peerRegistry = peerRegistry;
  this.logger = new Logger();
  // Need to now keep a copy of the original request.
  this.request = request;

  this.on('connecting', function() {
    self.state = STATES.CONNECTING;    
  });

  this.on('end', function() {
    self.state = STATES.DISCONNECTED;
    self._setRegistryStatus('disconnected');
    this._cleanup();
  });

  this.on('error', function(err) {
    self.state = STATES.DISCONNECTED;
    self._setRegistryStatus('failed', err);
   this._cleanup();
  });

  this.on('connected', function() {
    self.state = STATES.CONNECTED;
    self._setRegistryStatus('connected');
  });
  
  this.init(ws);
};
util.inherits(PeerSocket, EventEmitter);

Object.keys(STATES).forEach(function(k) {
  module.exports[k] = STATES[k];
});

PeerSocket.prototype.properties = function() {
  return {
    id: this.name,
    connectionId: this.connectionId
  };
};

PeerSocket.prototype.close = function() {
  clearInterval(this._pingTimer);
  this.ws.close();
};

PeerSocket.prototype._cleanup = function() {
  if (!this.agent) {
    return;
  }

  // Removing use of internals of spdy
  // TODO: validate memory leaks.
  //var streams = this.agent._spdyState.connection._spdyState.streams;
  //Object.keys(streams).forEach(function(k) {
  //  streams[k].destroy();
  //});

  this.agent.close();
};

PeerSocket.prototype.init = function(ws) {
  var self = this;
  self.emit('connecting');
  
  if (ws) {
    this._initWs(ws);
  }
  
  // delay because ws/spdy may not be fully established
  setImmediate(function() {
    // setup connection
    self._setupConnection(function(err) {
      if (err) {
        self.close();
        self.emit('error', err);
        return;
      }

      if (self.ws.readyState !== ws.OPEN) {
        // dissconnected already, reset
        self.close();
        self.emit('error', new Error('Peer Socket: Setup connection finished but ws not opened for peer "' + self.name + '".'));
        return;
      }

      var subscriptions = self.subscriptions;
      self.subscriptions = {}; // clear it before resubscribing
      // subscribe to all prev subscriptions
      Object.keys(subscriptions).forEach(function(event) {
        self.subscribe(event);
      });

      // TODO: get pings working with spdy fork.
      self._startPingTimer();

      self.emit('connected');
    });
  });
};

PeerSocket.prototype._setupConnection = function(cb, tries) {
  var self = this;
  var peerItem = {
    direction: 'acceptor',
    id: self.name,
    status: 'connecting'
  };

  self.peerRegistry.add(peerItem, function(err, newPeer) {
    if (err) {
      return cb(err);
    }

    // confirm connection with peer
    self.confirmConnection(self.connectionId, cb);
  });
};

PeerSocket.prototype._initWs = function(ws) {
  var self = this;
  var u = url.parse(this.request.url, true); // parse out connectionId
  this.ws = ws;
  this.connectionId = u.query.connectionId;
  this.ws._socket.removeAllListeners('data'); // Remove WebSocket data handler.

  this.ws._socket.on('end', function() {
    clearInterval(self._pingTimer);
    self.emit('end');
  });

  this.ws.on('error', function(err) {
    clearInterval(self._pingTimer);
    self.emit('error', err);
  });

  this.agent = spdy.createAgent(SpdyAgent, {
    // If host: is set it overides all headers for host set causing issues.
    // TODO: Remove after verifying spdy docs/source
    //host: this.name,
    port: 80,
    socket: this.ws._socket,
    spdy: {
      plain: true,
      ssl: false,
      protocol: 'h2'
    }
  });

  // TODO: Remove this when bug in agent socket removal is fixed.
  this.agent.maxSockets = 150;
  
  // TODO: This event is removed from the spdy lib now is emitted on the req.
  //this.agent.on('push', this.onPushData.bind(this));

  this.agent.on('error', function(err) {
    self.close();
    self.emit('error', err);
  });
};

PeerSocket.prototype._startPingTimer = function() {
  var self = this;
  clearInterval(this._pingTimer);
  this._pingTimer = setInterval(function() {
    var timeout = setTimeout(function() {
      self.close();
      self.emit('error', new Error('Peer socket timed out'));
    }, self._pingTimeout)

    self.agent._spdyState.connection.ping(function(err) {
      if (timeout) {
        clearTimeout(timeout);
      }
    });
  }, self._pingTimeout);

};

PeerSocket.prototype._setRegistryStatus = function(status, err, cb) {
  var self = this;
  
  if (typeof err === 'function') {
    cb = err;
    err = undefined;
  }

  if (!cb) {
    cb = function(){};
  }

  this.peerRegistry.get(this.name, function(err, peer) {
    if (err) {
      return cb(err);
    }

    peer.status = status;
    peer.connectionId = self.connectionId;
    if (err) {
      peer.error = err;
    }
    self.peerRegistry.save(peer, cb);
  });
};

PeerSocket.prototype.onPushData = function(stream) {
  // url -> path for whatever reason...
  // TODO: validate docs/source in spdy repo
  var streamUrl = stream.path.slice(1);
  var self = this;

  // TODO: this fixes an issue where streamURL is empty. Might
  // have always been empty was previously not closing the connection
  // when stream.connection.end was called.
  var checkTopic = stream.headers['topic'] || streamUrl;
  console.log(`header:${stream.headers['topic']} streamUrl:${streamUrl}`);
  if(!this.subscriptions[checkTopic]) {
    console.error('oh no missing', checkTopic, this.subscriptions);
    stream.connection.end();
  }

  var encoding = stream.headers['content-type'] || 'application/json';
  // remove additional parameters such as in `application/json; charset=utf-8`
  if (encoding.indexOf(';') !== -1) {
    encoding = encoding.split(';')[0].trim(); 
  }
  var length = Number(stream.headers['content-length']);
  var data = new Buffer(length);
  var idx = 0;
  var d = null;
  stream.on('readable', function() {
    while (d = stream.read()) {
      for (var i=0; i<d.length;i++) {
        data[idx++] = d[i];
      }
    };
  });

  stream.on('error', function(err) {
    console.error('error on push:', err);
  });

  stream.on('end', function() {
    var body = null;
    if (encoding === 'application/json') {
      try {
        body = JSON.parse(data.toString());
      } catch (err) {
        console.error('PeerSocket push data json parse error', err);
      }
    } else if(encoding === 'application/octet-stream') {
      body = data;
    }
    
    self.emit(streamUrl, body);
    self.emit('zetta-events', streamUrl, body)

    //TODO: verify any memory leaks without closing
    //stream.connection.close();
  });
};

PeerSocket.prototype.subscribe = function(event, cb) {
  if(!cb) {
    cb = function() {};
  }

  var queryPrefix = 'query%2F';
  if (event && event.slice(0, queryPrefix.length) === queryPrefix) {
    event = decodeURIComponent(event);
  }

  // keep track of number of subscriptions
  if (this.subscriptions[event] === undefined) {
    this.subscriptions[event] = 0;
  }
  this.subscriptions[event]++;

  // if already subscribed ignore
  if (this.subscriptions[event] > 1) {
    cb();
    return;
  }

  var host;
  if(this.ws && this.request) {
    host = this.request.headers.host
  } else {
    host = encodeURIComponent(this.name) + '.unreachable.zettajs.io';
  }

  var opts = {
    method: 'GET',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Host': host
    },
    path: '/servers/' + encodeURIComponent(this.name)
      + '/events?topic=' + encodeURIComponent(event),
    agent: this.agent
  };

  var req = http.request(opts, function(res) {
    cb();
  }).on('error', cb);
  
  // Push event now happens on the request object.
  req.on('push', this.onPushData.bind(this));

  req.end();
};

PeerSocket.prototype.unsubscribe = function(event, cb) { 
  if(!cb) {
    cb = function() {};
  }

  if (this.subscriptions[event] === undefined) {
    this.subscriptions[event] = 0;
  } else {
    this.subscriptions[event]--;
    if (this.subscriptions[event] < 0) {
      this.subscriptions[event] = 0;
    }
  }
  
  // only unsubscribe once all subscriptions count reaches 0
  if (this.subscriptions[event] > 0) {
    return cb();
  }

  var host;
  if(this.ws && this.request) {
    host = this.request.headers.host
  } else {
    host = encodeURIComponent(this.name) + '.unreachable.zettajs.io';
  }

  var body = new Buffer('topic='+event);
  var opts = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Host': host,
      'Content-Length': body.length
    },
    path: '/servers/' + encodeURIComponent(this.name) + '/events/unsubscribe',
    agent: this.agent
  };

  var req = http.request(opts, function(res) {
    cb();
  }).on('error', cb);
  req.end(body);
};

PeerSocket.prototype.confirmConnection = function(connectionId, callback) { 
  var timeout = setTimeout(function() {
    req.abort();
    callback(new Error('Confirm connection timeout reached.'));
  }, this._confirmationTimeout);
  
  var opts = { agent: this.agent, path: '/_initiate_peer/' + connectionId };
  var req = http.get(opts, function(res) {
    clearTimeout(timeout);
    if (res.statusCode !== 200) {
      return callback(new Error('Unexpected status code'));
    }
    callback();
  }).on('error', function(err) {
    clearTimeout(timeout);
    callback(err);
  });
};

PeerSocket.prototype.transition = function(action, args, cb) {
  var u = url.parse(action.href);
  var path = u.pathname;

  var body = new Buffer(querystring.stringify(args));

  var host;
  if(this.ws && this.request) {
    host = this.request.headers.host
  } else {
    host = encodeURIComponent(this.name) + '.unreachable.zettajs.io';
  }

  var opts = {
    agent: this.agent,
    path: path,
    method: action.method,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Host': host,
      'Content-Length': body.length,
    }
  };

  var req = http.request(opts, function(res) {
    var buffer = [];
    var len = 0;
    res.on('readable', function() {
      var data;
      while (data = res.read()) {
        buffer.push(data);
        len += data.length;
      }
    });

    res.on('end', function() {
      var buf = Buffer.concat(buffer, len);
      if (res.statusCode !== 200) {
        return cb(new Error(buf.toString()));
      }

      var jsonBody = null;
      try {
        jsonBody = JSON.parse(buf.toString());
      } catch(err) {
        return cb(new Error('Failed to parse body'));
      }
      return cb(null, jsonBody);
    });
  }).on('error', cb);
  req.end(body);
};

