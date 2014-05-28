/**
 * Module dependencies
 */

var util = require('util');
var path = require('path');
var _ = require('lodash');
var switchback = require('node-switchback');


/**
 * @type {Machine.constructor}
 */
module.exports = Machine;


/**
 * Construct a Machine.
 *
 * @optional {Object} machineDefinition
 *                      • defaults to an anonymous "halt" machine definition which, when
 *                        executed, does nothing byond calling its error exit.
 *
 * @optional {Module} dependenciesModuleContext
 *                      • if specified, the specified module will be used as the require context
 *                        for dependencies instead of assuming the machine module is a direct child
 *                        dependency of the parent module which required `node-machine`
 *                        TODO: in the future, allow a string path to be provided instead of a
 *                        core Module instance.
 *
 * @constructor {Machine}
 * @static Machine.require()
 * @static Machine.noop()
 * @public this.configure()
 * @public this.exec()
 */
function Machine(machineDefinition, dependenciesModuleContext) {
  if (!machineDefinition) return Machine.noop();

  // Ensure deps, inputs, and exits are defined
  machineDefinition.dependencies = machineDefinition.dependencies||{};
  machineDefinition.inputs = machineDefinition.inputs||{};
  machineDefinition.exits = machineDefinition.exits||{};

  // Initialize private state for this machine instance
  machineDefinition._configuredInputs = {};
  machineDefinition._configuredExits = {};
  machineDefinition._dependencies = {};

  // Fold in the rest of the provided `machineDefinition`
  _.extend(this, machineDefinition);

  // Default to the machine module as the dependency context
  // (find it by fuzzy-searching in `module.parent.children`
  //  for the most likely match)
  dependenciesModuleContext = dependenciesModuleContext||
  _(module.parent.children)
  .max(function rankEachModule (moduleRequiredByParent) {
    var _machineLikenessRank = 0;

    // Guess the likelihood of this being the correct module
    // by splitting the `id` on slashes and building a certainty
    // score (a % percentage) based on how far to the right-hand-side
    // the modulename appears as a substring in the `id` path.
    _(path.dirname(moduleRequiredByParent.id).split('/'))
    .reverse()
    .each(function (pathPart, i) {
      if (pathPart.match(machineDefinition.moduleName)) {
        _machineLikenessRank += 1.0/(i+1);
      }
      // console.log('(1.0/(i+1) :: ',(1.0/(i+1)));
      // console.log('(module.parent.children*1.0) :: ',(module.parent.children.length*1.0));
    });
    _machineLikenessRank *= 100*(1.0/module.parent.children.length);
    // console.log('I think it is %s% likely that "%s" is the machine you\'re looking for', _machineLikenessRank, moduleRequiredByParent.id);
    return _machineLikenessRank;
  }).valueOf();
  // console.log('dependenciesModuleContext:', dependenciesModuleContext);

  // Require dependencies for this machine, but do it from
  // the __dirname context of the machine machineDefinition module:
  _.each(this.dependencies||{}, function (versionStr, moduleName) {

    // handle case where dependenciesModuleContext could not be guessed
    if (!dependenciesModuleContext) {
      var err = new Error();
      err.code = 'MODULE_NOT_FOUND';
      err.message = util.format('Cannot resolve a context module to use for requiring dependencies of machine: "%s"',machineDefinition.moduleName);
      this.error(err);
      return false;
    }

    var machineCode;
    try {
      machineCode = dependenciesModuleContext.require(moduleName);
    }
    catch (e) {
      var err = new Error();
      err.code = 'MODULE_NOT_FOUND';
      err.message = util.format(
      'Cannot find module: "%s", a dependency of machine: "%s"\n'+
      '(attempted from the machine module\'s context: "%s")'+
      '\n%s',
      moduleName,machineDefinition.moduleName, module.parent.filename, e.stack||util.inspect(e));
      this.error(err);
      return false;
    }

    this._dependencies[moduleName] = machineCode;

  }, this);
}


/**
 * Machine.require()
 *
 * A static factory method which returns an instantiated machine.
 * An alternative to using the Machine constructor directly.
 *
 * @param {String} moduleName
 *                   • the commonjs module name path, as if it was being
 *                     used IN THE PARENT MODULE
 *                     (ie. the module which required `node-machine`)
 *
 * @return {Machine}
 */
Machine.require = function (moduleName) {

  // TODO: look up dependencies in the machine's package.json and merge them
  // into the `dependencies` key in the machine definition

  var machineDefinition;
  try {
    machineDefinition = module.parent.require(moduleName);
  }
  catch(e) {
    var err = new Error();
    err.code = 'MODULE_NOT_FOUND';
    err.message = util.format(
    'Cannot find machine: "%s"\n'+
    '(attempted from from `module.parent`, i.e.: "%s")'+
    '\n%s',
    moduleName, module.parent.filename, e.stack||util.inspect(e));
    throw err;
  }

  return new Machine(machineDefinition);

};


/**
 * Machine.noop()
 *
 * A static factory method which returns an anonymous machine whose only
 * purpose is to call its success exit.
 *
 * @return {Machine}
 */
Machine.noop = function () {
  return new Machine({
    id: '_noop',
    fn: function (inputs,exits,dependencies) {
      exits.success();
    }
  });
};


/**
 * Machine.halt()
 *
 * A static factory method which returns an anonymous machine whose only
 * purpose is to call its error exit with the specified `errorMsg`.
 *
 * @optional {*} error
 *                 • defaults to an Error object indicating that an unexpected
 *                   error occurred
 *
 * @return {Machine}
 */
Machine.halt = function (error) {

  error = error || (function (){
    var DEFAULT_HALT_ERROR = new Error();
    DEFAULT_HALT_ERROR.code = 'E_MACHINE_HALT';
    DEFAULT_HALT_ERROR.message = 'Executed a halt machine';
    return DEFAULT_HALT_ERROR;
  })();

  return new Machine({
    id: '_halt',
    fn: function (inputs,exits,dependencies) {
      exits.error(error);
    }
  });
};


/**
 * @param  {[type]} configuredInputs [description]
 * @chainable
 */
Machine.prototype.setInputs = function (configuredInputs) {
  _.extend(this._configuredInputs, _.cloneDeep(configuredInputs));

  return this;
};

/**
 * @param  {[type]} configuredExits [description]
 * @chainable
 */
Machine.prototype.setExits = function (configuredExits) {
  _.extend(this._configuredExits, _.cloneDeep(configuredExits));

  // Switchbackify
  this._configuredExits = switchback(this._configuredExits);

  // TODO: fwd any unspecified exits to catchall
  // TODO: if a formerly unspecified exit is specified, undo the fwding and make it explicit

  return this;
};


/**
 * [configure description]
 * @param  {[type]} configuredInputs [description]
 * @param  {[type]} configuredExits  [description]
 * @chainable
 */
Machine.prototype.configure = function (configuredInputs, configuredExits) {
  if (configuredExits) {
    this.setExits(configuredExits);
  }
  if (configuredInputs) {
    this.setInputs(configuredInputs);
  }
  return this;
};


/**
 * [exec description]
 * @param  {[type]} configuredExits [description]
 * @chainable
 */
Machine.prototype.exec = function (configuredExits) {
  if (configuredExits) {
    this.setExits(configuredExits);
  }

  // TODO: implement Deferred/promise usage

  this.fn(this._configuredInputs, this._configuredExits, this._dependencies);

  return this;
};


/**
 * Trigger an error on this machine.
 *
 * Uses configured `onError` function, or by default,
 * throws whatever was passed in.
 *
 * @chainable
 */
Machine.prototype.error = function () {

  /**
   * Default `onError` handler
   * @throws {Error}
   */
  (this.onError||function _defaultErrorHandler(err){
    throw err;
  }).apply(this, Array.prototype.slice.call(arguments));
};


/**
 * Trigger a warning on this machine.
 *
 * Uses configured `onWarn` function, or by default, logs
 * to `console.error`.
 *
 * @chainable
 */
Machine.prototype.warn = function () {

  /**
   * Default `onWarn` handler
   * @logs {String,String,...}
   */
  (this.onWarn||function _defaultWarnHandler(/*...*/){
    console.error.apply(console, Array.prototype.slice.call(arguments));
  }).apply(this, Array.prototype.slice.call(arguments));
};
