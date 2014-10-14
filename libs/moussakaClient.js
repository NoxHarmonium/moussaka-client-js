// Main class
(function (require, module) {
  'use strict';

  var utils = require('./utils.js');
  var _ = require('lodash');
  var superagent = require('superagent');
  var logger = require('./logger.js');
  var Ref = require('./ref.js');
  var path = require('path');
  // works in node and browser
  var EventEmitter = require('wolfy87-eventemitter');

  // # Required Params
  // deviceName:        The identifier for this client
  // apiKey:            User's API key for authentication
  // projectId:         The id of the associated project
  // projectVersion:    The version of this this application
  // # Params
  // serverUrl:         The server url (default: localhost:80)
  // pollInterval:      The rate to poll the server for updates (in ms)
  var MoussakaClient = function (opts) {

    utils.validateRequiredOptions(opts, ['deviceName', 'apiKey',
      'projectId', 'projectVersion'
    ]);

    // Defaults
    this.serverUrl = 'http://localhost:3000/';
    this.pollInterval = 1000; //ms

    _.assign(this, opts);

    // Fields
    this.registedVars = {};
    this.connected = false;
    this.dataSchema = {};
    this.agent = superagent.agent();
    this.polling = false;
    this.intervalId = null;
    this.pollErrorCount = 0;
    this.pollReady = true;

  };

  // Inherit EventEmitter
  MoussakaClient.prototype = _.clone(EventEmitter.prototype);

  MoussakaClient.prototype.registerVar = function (name, value, schema) {
    if (this.registedVars[name]) {
      throw new Error('Variable with that name already registered.');
    }

    var ref = new Ref(value);

    this.registedVars[name] = {
      ref: ref,
      schema: schema
    };

    this.updateSchema();

    return ref;
  };

  MoussakaClient.prototype.updateSchema = function () {
    if (this.connected) {
      throw new Error('Cannot update schema after connect.');
    }

    var dataSchema = {};
    _.each(this.registedVars, function (variable, name) {
      if (!variable.schema) {
        // Create a schema by guessing
        var type = null;
        var ref = variable.ref;

        logger.trace('Updating schema with: ' + name);
        logger.trace('Type: ' + typeof(ref.value));
        logger.trace('Complex: ' + !!ref.value.getType);

        switch (typeof (ref.value)) {
        case 'boolean':
          type = 'boolean';
          break;
        case 'number':
          type = 'float';
          break;
        case 'string':
          type = 'string';
          break;
        }

        if (ref.value.getType) {
          type = ref.value.getType();
        }

        if (!type) {
          throw new Error('Cannot deduce object type. ' +
            'Please pass in a schema object.');
        }

        dataSchema[name] = {
          type: type
        };
      } else {
        dataSchema[name] = variable.schema;
      }
    });

    // Success!
    this.dataSchema = dataSchema;
  };

  MoussakaClient.prototype.connect = function () {
    var url = this.serverUrl + path.join('/projects/',
      this.projectId, 'devices/');
    logger.trace('Connecting device at: ' + url);
    this.agent.put(url)
      .send({
        projectId: this.projectId,
        projectVersion: this.projectVersion,
        deviceName: this.deviceName
      })
      .end(function (e, res) {
        if (e) {
          throw e;
        }

        if (res.ok) {
          this.connected = true;
          this._id = res.body._id;
          logger.trace('Connected!: _id: ' + this._id);
          this.emit('connect', this._id);
          this.beginPolling();
        } else {
          throw new Error('Server returned error: Status: ' +
            res.status + ' Detail:' + res.body.detail);
        }

      }.bind(this));
  };

  MoussakaClient.prototype.disconnect = function () {
    var url = this.serverUrl + path.join('/projects/',
      this.projectId, 'devices/', this._id, '/');
    logger.trace('Disconnecting device at: ' + url);

    this.stopPolling();

    this.agent.del(url)
      .end(function (e, res) {
        if (e) {
          throw e;
        }

        if (res.ok) {
          this.connected = false;
        } else {
          throw new Error('Server returned error: Status: ' +
            res.status + ' Detail:' + res.body.detail);
        }

      }.bind(this));
  };

  MoussakaClient.prototype.beginPolling = function () {
    if (!this.connected || this.polling) {
      throw new Error('This method should only be called by the ' +
        'connect function.');
    }

    logger.trace('Starting polling');

    this.intervalId = setInterval(this.pollFn.bind(this),
      this.pollInterval);
    this.polling = true;
  };

  MoussakaClient.prototype.pollFn = function () {
    var url = this.serverUrl + path.join('/projects/',
      this.projectId, 'sessions/', this._id, '/updates/');

    if (!this.pollReady) {
      logger.warn('pollFn called before last poll completed. ' +
        'Skipping poll. Make sure poll frequency is not to fast.');
    }

    this.pollReady = false;
    this.agent.get(url)
      .end(function (e, res) {
        this.pollReady = true;
        if (e) {
          if (++this.pollErrorCount > 5) {
            logger.error('5 poll errors encountered in a row. ' +
              'Disconnecting...');
            this.disconnect();
          }
          throw e;
        }

        if (res.ok) {
          this.pollErrorCount = 0;
          this.applyUpdates(res.body);
        } else {
          throw new Error('Server returned error: Status: ' +
            res.status + ' Detail:' + res.body.detail);
        }

      }.bind(this));
  };

  MoussakaClient.prototype.stopPolling = function () {
    logger.trace('Stopping polling');
    if (!this.intervalId && this.polling){
      throw new Error('Polling started but no intervalId.');
    }
    if (!this.intervalId || !this.polling) {
      throw new Error('Polling has not been started.');
    }
    clearInterval(this.intervalId);
    this.polling = false;
  };

  MoussakaClient.prototype.applyUpdates = function (updates) {
    if (!updates) {
      logger.warn('Updates is null.');
      return;
    }

    _.each(updates, function (update, key) {
      var values = update.values;
      var variable = this.registedVars[key].ref;
      var type = variable.schema.type;

      switch (variable.schema.type) {
        // Primitives
      case 'float':
      case 'double':
      case 'decimal':
        variable.value = values.n;
        break;
      case 'string':
        variable.value = values.s;
        break;
      case 'boolean':
        variable.value = values.b;
        break;
      default:
        // Complex Type
        if (variable.value.setValues) {
          variable.value.setValues(values);
        } else {
          logger.warn('Unsupported variable type: ' + type);
        }
        break;
      }

    });

  };

  module.exports = MoussakaClient;

})(require, module);