/*
 * Copyright 2016 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
'use strict';

var eventEmitter = require('minimal-event-emitter');

var RenderLoop = require('./RenderLoop');
var Controls = require('./controls/Controls');
var Layer = require('./Layer');
var TextureStore = require('./TextureStore');

var Scene = require('./Scene');

var Timer = require('./Timer');

var WebGlStage = require('./stages/WebGl');
var CssStage = require('./stages/Css');
var FlashStage = require('./stages/Flash');

var registerDefaultControls = require('./controls/registerDefaultControls');
var registerDefaultRenderers = require('./renderers/registerDefaultRenderers');

var setOverflowHidden = require('./util/dom').setOverflowHidden;
var setAbsolute = require('./util/dom').setAbsolute;
var setFullSize = require('./util/dom').setFullSize;
var setBlocking = require('./util/dom').setBlocking;

var tween = require('./util/tween');
var noop = require('./util/noop');
var type = require('./util/type');

var DragCursor = require('./controls/DragCursor');

var HammerGestures = require('./controls/HammerGestures');

var browser = require('bowser');

var stageMap = {
  webgl: WebGlStage,
  css: CssStage,
  flash: FlashStage
};

var stagePrefList = [
  WebGlStage,
  CssStage,
  FlashStage
];

/**
 * Signals that the current scene has changed.
 * @event Viewer#sceneChange
 */

/**
 * Signals that the view of the current scene has changed. See
 * {@link View#event:change}.
 * @event Viewer#viewChange
 */

/**
 * @class
 * @classdesc
 * A Viewer is a container for multiple {@link Scene scenes} to be displayed
 * inside a {@link Stage stage} contained in the DOM.
 *
 * Scenes may be created by calling {@link Viewer#createScene}. Except during a
 * scene switch, a single one of them, called the current scene, is visible.
 * Calling {@link Viewer#switchScene} sets the current scene and switches to it.
 *
 * @param {Element} domElement The DOM element to contain the stage.
 * @param {Object} opts Viewer creation options.
 * @param {(null|'webgl'|'css'|'flash')} [opts.stageType=null] The type of stage
 *     to create. The default is to choose the most appropriate type depending
 *     on the browser capabilities.
 * @param {Object} opts.controls Options to be passed to
 *     {@link registerDefaultControls}.
 * @param {Object} opts.stage Options to be passed to the {@link Stage}
 *     constructor.
 */
function Viewer(domElement, opts) {
  opts = opts || {};

  this._domElement = domElement;

  // Add `overflow: hidden` to the domElement.
  setOverflowHidden(domElement);

  // Select the stage type to use.
  var Stage;
  if (opts.stageType) {
    // If a specific stage type was specified, use that one.
    Stage = stageMap[opts.stageType];
    if (!Stage) {
      throw new Error('Unknown stage type: ' + opts.stageType);
    }
  } else {
    // Choose the best supported stage according to the default preference
    // order. Note that this may yield an unsupported stage for some
    // geometry/view combinations. Client code is expected to pass in a
    // specific stage type in those cases.
    for (var i = 0; i < stagePrefList.length; i++) {
      if (stagePrefList[i].supported()) {
        Stage = stagePrefList[i];
        break;
      }
    }
    if (!Stage) {
      throw new Error('None of the stage types are supported');
    }
  }

  // Create stage.
  this._stage = new Stage(opts.stage);

  // Register the default renderers for the selected stage.
  registerDefaultRenderers(this._stage);

  // Add the stage element into the DOM.
  this._domElement.appendChild(this._stage.domElement());

  // Create control container.
  // Controls cannot be placed directly on the root DOM element because
  // Hammer.js will prevent click events from reaching the elements beneath.

  // The hotspot containers will be added inside the controls container.
  this._controlContainer = document.createElement('div');
  setAbsolute(this._controlContainer);
  setFullSize(this._controlContainer);

  // Prevent bounce scroll effect on iOS.
  // Applied only for iOS, as Android's events must have the default action to allow interaction with hotspots.
  if (browser.ios) {
    this._controlContainer.addEventListener('touchstart', function(event) {
      event.preventDefault();
    });
  }


  // Old IE does not detect mouse events on elements without background
  // Add a child element to the controls with full width, a background color
  // and opacity 0
  var controlCapture = document.createElement('div');
  setAbsolute(controlCapture);
  setFullSize(controlCapture);
  setBlocking(controlCapture);

  this._controlContainer.appendChild(controlCapture);
  domElement.appendChild(this._controlContainer);

  // Respond to window size changes.
  this._size = {};
  this.updateSize();
  this._updateSizeListener = this.updateSize.bind(this);
  window.addEventListener('resize', this._updateSizeListener);

  // Create render loop.
  this._renderLoop = new RenderLoop(this._stage);

  // Create the controls and register them with the render loop.
  this._controls = new Controls();
  this._controlMethods = registerDefaultControls(this._controls, this._controlContainer, opts.controls);
  this._controls.attach(this._renderLoop);

  // Expose HammerJS.
  this._hammerManagerTouch = HammerGestures.get(this._controlContainer, 'touch');
  this._hammerManagerMouse = HammerGestures.get(this._controlContainer, 'mouse');

  // Initialize mouse cursor.
  opts.cursors = opts.cursors || {};
  this._dragCursor = new DragCursor(this._controls, 'mouseViewDrag', domElement, opts.cursors.drag);

  // Start the render loop.
  this._renderLoop.start();

  // Scene list.
  this._scenes = [];

  // The currently visible scene.
  this._scene = null;

  // The number of stage layers belonging to the currently visible scene.
  // This is necessary to update the layers correctly when they are added or
  // removed during a scene transition.
  this._sceneLayerCount = 0;

  // The current transition.
  this._cancelCurrentTween = null;

  // The event listener fired when the current scene layers change.
  // This is attached to the correct scene whenever the current scene changes.
  this._layerChangeHandler = this._updateSceneLayers.bind(this);

  // The event listener fired when the current scene view changes.
  // This is attached to the correct scene whenever the current scene changes.
  this._viewChangeHandler = this.emit.bind(this, 'viewChange');

  // Setup the idle timer.
  // By default, the timer has an infinite duration so it does nothing.
  this._idleTimer = new Timer();
  this._idleTimer.start();

  // Reset the timer whenever the view changes.
  this._resetIdleTimerHandler = this._resetIdleTimer.bind(this);
  this.addEventListener('viewChange', this._resetIdleTimerHandler);

  // Start the idle movement when the idle timer fires.
  this._enterIdleHandler = this._enterIdle.bind(this);
  this._idleTimer.addEventListener('timeout', this._enterIdleHandler);

  // Stop the idle movement when the controls are activated or when the
  // scene changes.
  this._leaveIdleHandler = this._leaveIdle.bind(this);
  this._controls.addEventListener('active', this._leaveIdleHandler);
  this.addEventListener('sceneChange', this._leaveIdleHandler);

  // The currently programmed idle movement.
  this._idleMovement = null;
}

eventEmitter(Viewer);


/**
 * Destructor.
 */
Viewer.prototype.destroy = function() {

  window.removeEventListener('resize', this._updateSizeListener);
  this._updateSizeListener = null;
  this._size = null;

  if (this._scene) {
    this._scene.removeEventListener('layerChange', this._layerChangeHandler);
    this._scene.removeEventListener('viewChange', this._viewChangeHandler);
  }
  this._layerChangeHandler = null;
  this._viewChangeHandler = null;

  for (var methodName in this._controlMethods) {
    this._controlMethods[methodName].destroy();
  }
  this._controlMethods = null;

  while (this._scenes.length) {
    this.destroyScene(this._scenes[0]);
  }

  this._scenes = null;
  this._scene = null;
  this._sceneLayerCount = null;

  // The Flash renderer must be torn down before the element is removed from
  // the DOM, so all scenes must have been destroyed before this point.
  this._domElement.removeChild(this._stage.domElement());

  this._stage.destroy();
  this._stage = null;

  this._renderLoop.destroy();
  this._renderLoop = null;

  this._controls.destroy();
  this._controls = null;

  if (this._cancelCurrentTween) {
    this._cancelCurrentTween();
    this._cancelCurrentTween = null;
  }

  this._domElement = null;
  this._controlContainer = null;

};


/**
 * Updates the stage size to fill the containing element.
 *
 * This method is automatically called when the browser window is resized.
 * Most clients won't need to explicitly call it to keep the size up to date.
 */
Viewer.prototype.updateSize = function() {
  var size = this._size;
  size.width = this._domElement.clientWidth;
  size.height = this._domElement.clientHeight;
  this._stage.setSize(size);
};


/**
 * Returns the underlying {@link Stage stage}.
 * @return {Stage}
 */
Viewer.prototype.stage = function() {
  return this._stage;
};


/**
 * Returns the underlying {@link RenderLoop render loop}.
 * @return {RenderLoop}
 */
Viewer.prototype.renderLoop = function() {
  return this._renderLoop;
};


/**
 * Returns the underlying {@link Controls controls}.
 * @return {Controls}
 */
Viewer.prototype.controls = function() {
  return this._controls;
};


/**
 * Returns the underlying DOM element.
 * @return {Element}
 */
Viewer.prototype.domElement = function() {
  return this._domElement;
};


/**
 * Creates a new {@link Scene scene} with a single layer and adds it to the
 * viewer.
 *
 * The current scene does not change. To switch to the scene, call
 * {@link Viewer#switchScene}.
 *
 * @param {Object} opts Scene creation options.
 * @param {View} opts.view The scene's underlying {@link View}.
 * @param {Source} opts.source The layer's underlying {@link Source}.
 * @param {Geometry} opts.geometry The layer's underlying {@link Geometry}.
 * @param {boolean} [opts.pinFirstLevel=false] Whether to pin the first level to
 *     provide a fallback of last resort, at the cost of memory consumption.
 * @param {Object} [opts.textureStoreOpts={}] Options to pass to the
 *     {@link TextureStore} constructor.
 * @param {Object} [opts.layerOpts={}] Options to pass to the {@link Layer}
 *     constructor.
 * @return {Scene}
 */
Viewer.prototype.createScene = function(opts) {
  opts = opts || {};

  var scene = this.createEmptyScene({ view: opts.view });

  var layer = scene.createLayer({
    source: opts.source,
    geometry: opts.geometry,
    pinFirstLevel: opts.pinFirstLevel,
    textureStoreOpts: opts.textureStoreOpts,
    layerOpts: opts.layerOpts
  });

  return scene;
};


/**
 * Creates a new {@link Scene scene} with no layers and adds it to the viewer.
 *
 * Layers may be added to the scene by calling {@link Scene#createLayer}.
 * However, if the scene has a single layer, it is simpler to call
 * {@link Viewer#createScene} instead of this method.
 *
 * The current scene does not change. To switch to the scene, call
 * {@link Viewer#switchScene}.
 *
 * @param {Object} opts Scene creation options.
 * @param {View} opts.view The scene's underlying {@link View}.
 * @return {Scene}
 */
Viewer.prototype.createEmptyScene = function(opts) {
  opts = opts || {};

  var scene = new Scene(this, opts.view);
  this._scenes.push(scene);

  return scene;
};


Viewer.prototype._updateSceneLayers = function() {
  var stage = this._stage;
  var scene = this._scene;

  var stageLayerList = stage.listLayers();
  var sceneLayerList = scene.listLayers();

  // Note that the stage may contain layers from another scene if a transition
  // is taking place. However, the layers for the current scene are always at
  // the top.
  var stageLayerCount = this._sceneLayerCount;
  var sceneLayerCount = sceneLayerList.length;

  // A single layer can be added or removed from the scene at a time.
  if (Math.abs(stageLayerCount - sceneLayerCount) !== 1) {
    throw new Error('Stage and scene out of sync');
  }

  if (sceneLayerCount < stageLayerCount) {
    // A layer was removed.
    for (var i = 0; i < stageLayerList.length; i++) {
      var layer = stageLayerList[i];
      if (sceneLayerList.indexOf(layer) < 0) {
        this._removeLayerFromStage(layer);
        break;
      }
    }
  }
  if (sceneLayerCount > stageLayerCount) {
    // A layer was added.
    for (var i = 0; i < sceneLayerList.length; i++) {
      var layer = sceneLayerList[i];
      if (stageLayerList.indexOf(layer) < 0) {
        this._addLayerToStage(layer, i + stageLayerCount - sceneLayerCount + 1);
      }
    }
  }

  // TODO: When in the middle of a scene transition, we must also remove from
  // the stage layers that have been removed from the previous scene. Otherwise,
  // they remain in the stage in a destroyed state, which will eventually cause
  // a crash.

  // TODO: When in the middle of a scene transition, call the transition update
  // function immediately to prevent an added layer from flashing with the wrong
  // opacity.

  this._sceneLayerCount = sceneLayerCount;
};


Viewer.prototype._addLayerToStage = function(layer, i) {
  // Pin the first level to ensure a fallback while the layer is visible.
  // Note that this is distinct from the `pinFirstLevel` option passed to
  // createScene(), which pins the layer even when it's not visible.
  layer.pinFirstLevel();
  this._stage.addLayer(layer, i);
};


Viewer.prototype._removeLayerFromStage = function(layer) {
  this._stage.removeLayer(layer);
  layer.unpinFirstLevel();
  layer.textureStore().clearNotPinned();
};


/**
 * Destroys a {@link Scene scene} and removes it from the viewer.
 * @param {Scene} scene
 */
Viewer.prototype.destroyScene = function(scene) {
  var i = this._scenes.indexOf(scene);
  if (i < 0) {
    throw new Error('No such scene in viewer');
  }

  if (this._scene === scene) {
    // If the currently visible scene is destroyed, display an empty stage.
    var layers = scene.listLayers();
    for (var i = 0; i < layers.length; i++) {
      this.removeLayerFromStage(layers[i]);
    }

    if (this._cancelCurrentTween) {
      this._cancelCurrentTween();
      this._cancelCurrentTween = null;
    }

    this._scene = null;
    this._sceneLayerCount = 0;
  }

  this._scenes.splice(i, 1);

  scene.destroy();
};


/**
 * Destroys all {@link Scene scenes} and removes them from the viewer.
 */
Viewer.prototype.destroyAllScenes = function() {
  while (this._scenes.length > 0) {
    this.destroyScene(this._scenes[0]);
  }
};


/**
 * Returns whether the viewer contains a {@link Scene scene}.
 * @param {Scene} scene
 * @return {boolean}
 */
Viewer.prototype.hasScene = function(scene) {
  return this._scenes.indexOf(scene) >= 0;
};


/**
 * Returns a list of all {@link Scene scenes}.
 * @return {Scene[]}
 */
Viewer.prototype.listScenes = function() {
  return [].concat(this._scenes);
};


/**
 * Returns the current {@link Scene scene}, or null if there isn't one.
 *
 * To change the current scene, call {@link Viewer#switchScene}.
 *
 * @return {Scene}
 */
Viewer.prototype.scene = function() {
  return this._scene;
};


/**
 * Returns the {@link View view} for the current {@link Scene scene}, or null
 * if there isn't one.
 * @return {View}
 */
Viewer.prototype.view = function() {
  var scene = this._scene;
  if (scene) {
    return scene.view();
  }
  return null;
};


/**
 * Tweens the {@link View view} for the current {@link Scene scene}.
 *
 * This method is equivalent to calling {@link Scene#lookTo} on the current
 * scene.
 *
 * @param {Object} opts Options to pass into {@link Scene#lookTo}.
 * @param {function} done Function to call when the tween is complete.
 */
Viewer.prototype.lookTo = function(params, opts, done) {
  // TODO: is it an error to call lookTo when no scene is displayed?
  var scene = this._scene;
  if (scene) {
    scene.lookTo(params, opts, done);
  }
};


/**
 * Starts a movement.
 *
 * This method is equivalent to calling {@link Scene#startMovement} on the
 * current scene.
 *
 * @param {function} fn The movement function.
 * @param {function} done Function to be called when the movement finishes or is
 *     interrupted.
 */
Viewer.prototype.startMovement = function(fn, cb) {
  // TODO: is it an error to call startMovement when no scene is displayed?
  var scene = this._scene;
  if (scene) {
    scene.startMovement(fn, cb);
  }
};


/**
 * Stops the current movement.
 *
 * This method is equivalent to calling {@link Scene#stopMovement} on the
 * current scene.
 */
Viewer.prototype.stopMovement = function() {
  var scene = this._scene;
  if (scene) {
    scene.stopMovement();
  }
};


/**
 * Schedules an idle movement to be automatically started when the view remains
 * unchanged for the given timeout period.
 *
 * Changing the view while the idle movement is active stops the movement and
 * schedules it to start again after the same timeout period. To disable it
 * permanently, call with a null movement or an infinite timeout.
 *
 * @param {number} timeout Timeout period in milliseconds.
 * @param {function} movement Automatic movement function, or null to disable.
 */
Viewer.prototype.setIdleMovement = function(timeout, movement) {
  this._idleTimer.setDuration(timeout);
  this._idleMovement = movement;
};


/**
 * Stops the idle movement. It will be started again after the timeout set by
 * {@link Viewer#setIdleMovement}.
 */
Viewer.prototype.breakIdleMovement = function() {
  this._leaveIdle();
  this._resetIdleTimer();
};


Viewer.prototype._resetIdleTimer = function() {
  this._idleTimer.start();
};


Viewer.prototype._enterIdle = function() {
  var scene = this._scene;
  var idleMovement = this._idleMovement;
  if (!scene || !idleMovement) {
    return;
  }
  scene.startMovement(idleMovement);
};


Viewer.prototype._leaveIdle = function() {
  var scene = this._scene;
  if (!scene) {
    return;
  }
  if (scene.movement() === this._idleMovement) {
    scene.stopMovement();
  }
};


var defaultSwitchDuration = 1000;

function defaultTransitionUpdate(val, newScene, oldScene) {
  var layers = newScene.listLayers();
  layers.forEach(function(layer) {
    layer.mergeEffects({ opacity: val });
  });

  newScene._hotspotContainer.domElement().style.opacity = val;
}


/**
 * Switches to another {@link Scene scene} with a fade transition. This scene
 * becomes the current one.
 *
 * If a transition is already taking place, it is interrupted before the new one
 * starts.
 *
 * @param {Scene} newScene The scene to switch to.
 * @param {Object} opts Transition options.
 * @param {number} [opts.transitionDuration=1000] Transition duration, in
 *     milliseconds.
 * @param {number} [opts.transitionUpdate=defaultTransitionUpdate]
 *     Transition update function, with signature `f(t, newScene, oldScene)`.
 *     This function is called on each frame with `t` increasing from 0 to 1.
 *     An initial call with `t=0` and a final call with `t=1` are guaranteed.
 *     The default function sets the opacity of the new scene to `t`.
 * @param {function} done Function to call when the transition finishes or is
 *     interrupted. If the new scene is equal to the old one, no transition
 *     takes place, but this function is still called.
 */
Viewer.prototype.switchScene = function(newScene, opts, done) {
  var self = this;

  opts = opts || {};
  done = done || noop;

  var stage = this._stage;

  var oldScene = this._scene;

  // Do nothing if the target scene is the current one.
  if (oldScene === newScene) {
    done();
    return;
  }

  if (this._scenes.indexOf(newScene) < 0) {
    throw new Error('No such scene in viewer');
  }

  // Cancel an already ongoing transition. This ensures that the stage contains
  // layers from exactly one scene before the transition begins.
  if (this._cancelCurrentTween) {
    this._cancelCurrentTween();
    this._cancelCurrentTween = null;
  }

  var oldSceneLayers = oldScene ? oldScene.listLayers() : [];
  var newSceneLayers = newScene.listLayers();
  var stageLayers = stage.listLayers();

  // Check that the stage contains exactly as many layers as the current scene,
  // and that the top layer is the right one. If this test fails, either there
  // is a bug or the user tried to modify the stage concurrently.
  if (oldScene && ((stageLayers.length !== oldSceneLayers.length) ||
      (stageLayers.length > 1 && stageLayers[0] != oldSceneLayers[0]))) {
    throw new Error('Stage not in sync with viewer');
  }

  // Get the transition parameters.
  var duration = opts.transitionDuration != null ?
      opts.transitionDuration : defaultSwitchDuration;
  var update = opts.transitionUpdate != null ?
      opts.transitionUpdate : defaultTransitionUpdate;

  // Add new scene layers into the stage before starting the transition.
  var newSceneLayers = newScene.listLayers();
  for (var i = 0; i < newSceneLayers.length; i++) {
    this._addLayerToStage(newSceneLayers[i]);
  }

  // Update function to be called on every frame.
  function tweenUpdate(val) {
    update(val, newScene, oldScene);
  }

  // Remove old scene layers from the stage after the transition ends.
  // Note that the old scene layer list is still valid, because stage layers
  // for the old scene are not updated during the transition.
  function tweenDone() {
    if (oldScene) {
      for (var i = 0; i < oldSceneLayers.length; i++) {
        self._removeLayerFromStage(oldSceneLayers[i]);
      }
    }
    self._cancelCurrentTween = null;
    done();
  }

  // Store the cancelable for the transition.
  this._cancelCurrentTween = tween(duration, tweenUpdate, tweenDone);

  // Update the current scene and scene layer count.
  this._scene = newScene;
  this._sceneLayerCount = newSceneLayers.length;

  // Emit scene and view change events.
  this.emit('sceneChange');
  this.emit('viewChange');

  // Switch event listeners over to the new scene.
  if (oldScene) {
    oldScene.removeEventListener('layerChange', this._layerChangeHandler);
    oldScene.removeEventListener('viewChange', this._viewChangeHandler);
  }
  newScene.addEventListener('layerChange', this._layerChangeHandler);
  newScene.addEventListener('viewChange', this._viewChangeHandler);
};


module.exports = Viewer;
