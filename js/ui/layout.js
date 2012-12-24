// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

const Clutter = imports.gi.Clutter;
const ClutterX11 = imports.gi.ClutterX11;
const GObject = imports.gi.GObject;
const Lang = imports.lang;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const Shell = imports.gi.Shell;
const Signals = imports.signals;
const St = imports.gi.St;

const DND = imports.ui.dnd;
const Main = imports.ui.main;
const Params = imports.misc.params;
const Tweener = imports.ui.tweener;

const HOT_CORNER_ACTIVATION_TIMEOUT = 0.5;
const STARTUP_ANIMATION_TIME = 1;
const KEYBOARD_ANIMATION_TIME = 0.15;
const DEFAULT_BACKGROUND_COLOR = Clutter.Color.from_pixel(0x2e3436ff);

const MonitorConstraint = new Lang.Class({
    Name: 'MonitorConstraint',
    Extends: Clutter.Constraint,
    Properties: {'primary': GObject.ParamSpec.boolean('primary', 
                                                      'Primary', 'Track primary monitor',
                                                      GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE,
                                                      false),
                 'index': GObject.ParamSpec.int('index',
                                                'Monitor index', 'Track specific monitor',
                                                GObject.ParamFlags.READABLE | GObject.ParamFlags.WRITABLE,
                                                -1, 64, -1)},

    _init: function(props) {
        this._primary = false;
        this._index = -1;

        this.parent(props);
    },

    get primary() {
        return this._primary;
    },

    set primary(v) {
        if (v)
            this._index = -1;
        this._primary = v;
        if (this.actor)
            this.actor.queue_relayout();
        this.notify('primary');
    },

    get index() {
        return this._index;
    },

    set index(v) {
        this._primary = false;
        this._index = v;
        if (this.actor)
            this.actor.queue_relayout();
        this.notify('index');
    },

    vfunc_set_actor: function(actor) {
        if (actor) {
            if (!this._monitorsChangedId) {
                this._monitorsChangedId = Main.layoutManager.connect('monitors-changed', Lang.bind(this, function() {
                    this.actor.queue_relayout();
                }));
            }
        } else {
            if (this._monitorsChangedId)
                Main.layoutManager.disconnect(this._monitorsChangedId);
            this._monitorsChangedId = 0;
        }

        this.parent(actor);
    },

    vfunc_update_allocation: function(actor, actorBox) {
        if (!this._primary && this._index < 0)
            return;

        let monitor;
        if (this._primary) {
            monitor = Main.layoutManager.primaryMonitor;
        } else {
            let index = Math.min(this._index, Main.layoutManager.monitors.length - 1);
            monitor = Main.layoutManager.monitors[index];
        }

        actorBox.init_rect(monitor.x, monitor.y, monitor.width, monitor.height);
    }
});

const defaultParams = {
    trackFullscreen: false,
    affectsStruts: false,
    affectsInputRegion: true
};

const LayoutManager = new Lang.Class({
    Name: 'LayoutManager',

    _init: function () {
        this._rtl = (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL);
        this.monitors = [];
        this.primaryMonitor = null;
        this.primaryIndex = -1;
        this._keyboardIndex = -1;
        this._hotCorners = [];
        this._leftPanelBarrier = 0;
        this._rightPanelBarrier = 0;

        this._inOverview = false;
        this._updateRegionIdle = 0;

        this._trackedActors = [];

        // Normally, the stage is always covered so Clutter doesn't need to clear
        // it; however it becomes visible during the startup animation
        // See the comment below for a longer explanation
        global.stage.color = DEFAULT_BACKGROUND_COLOR;

        // Set up stage hierarchy to group all UI actors under one container.
        this.uiGroup = new Shell.GenericContainer({ name: 'uiGroup' });
        this.uiGroup.connect('allocate',
                        function (actor, box, flags) {
                            let children = actor.get_children();
                            for (let i = 0; i < children.length; i++)
                                children[i].allocate_preferred_size(flags);
                        });
        this.uiGroup.connect('get-preferred-width',
                        function(actor, forHeight, alloc) {
                            let width = global.stage.width;
                            [alloc.min_size, alloc.natural_size] = [width, width];
                        });
        this.uiGroup.connect('get-preferred-height',
                        function(actor, forWidth, alloc) {
                            let height = global.stage.height;
                            [alloc.min_size, alloc.natural_size] = [height, height];
                        });

        global.window_group.reparent(this.uiGroup);

        // Now, you might wonder why we went through all the hoops to implement
        // the GDM greeter inside an X11 compositor, to do this at the end...
        // However, hiding this is necessary to avoid showing the background during
        // the initial animation, before Gdm.LoginDialog covers everything
        if (Main.sessionMode.isGreeter)
            global.window_group.hide();

        global.overlay_group.reparent(this.uiGroup);
        global.stage.add_child(this.uiGroup);

        this.screenShieldGroup = new St.Widget({ name: 'screenShieldGroup',
                                                 visible: false,
                                                 clip_to_allocation: true,
                                                 layout_manager: new Clutter.BinLayout(),
                                               });
        this.addChrome(this.screenShieldGroup);

        this.panelBox = new St.BoxLayout({ name: 'panelBox',
                                           vertical: true });
        this.addChrome(this.panelBox, { affectsStruts: true,
                                        trackFullscreen: true });
        this.panelBox.connect('allocation-changed',
                              Lang.bind(this, this._panelBoxChanged));

        this.trayBox = new St.Widget({ name: 'trayBox',
                                       layout_manager: new Clutter.BinLayout() });
        this.addChrome(this.trayBox);

        this.keyboardBox = new St.BoxLayout({ name: 'keyboardBox',
                                              reactive: true,
                                              track_hover: true });
        this.addChrome(this.keyboardBox);
        this._keyboardHeightNotifyId = 0;

        // Need to update struts on new workspaces when they are added
        global.screen.connect('notify::n-workspaces',
                              Lang.bind(this, this._queueUpdateRegions));
        global.screen.connect('restacked',
                              Lang.bind(this, this._windowsRestacked));
        global.screen.connect('monitors-changed',
                              Lang.bind(this, this._monitorsChanged));
        this._monitorsChanged();
    },

    // This is called by Main after everything else is constructed;
    // it needs access to Main.overview, which didn't exist
    // yet when the LayoutManager was constructed.
    init: function() {
        Main.overview.connect('showing', Lang.bind(this, this._overviewShowing));
        Main.overview.connect('hidden', Lang.bind(this, this._overviewHidden));
        Main.sessionMode.connect('updated', Lang.bind(this, this._sessionUpdated));

        this._prepareStartupAnimation();
    },

    _overviewShowing: function() {
        this._inOverview = true;
        this._updateVisibility();
        this._queueUpdateRegions();
    },

    _overviewHidden: function() {
        this._inOverview = false;
        this._updateVisibility();
        this._queueUpdateRegions();
    },

    _sessionUpdated: function() {
        this._updateVisibility();
        this._queueUpdateRegions();
    },

    _updateMonitors: function() {
        let screen = global.screen;

        this.monitors = [];
        let nMonitors = screen.get_n_monitors();
        for (let i = 0; i < nMonitors; i++)
            this.monitors.push(screen.get_monitor_geometry(i));

        if (nMonitors == 1) {
            this.primaryIndex = this.bottomIndex = 0;
        } else {
            // If there are monitors below the primary, then we need
            // to split primary from bottom.
            this.primaryIndex = this.bottomIndex = screen.get_primary_monitor();
            for (let i = 0; i < this.monitors.length; i++) {
                let monitor = this.monitors[i];
                if (this._isAboveOrBelowPrimary(monitor)) {
                    if (monitor.y > this.monitors[this.bottomIndex].y)
                        this.bottomIndex = i;
                }
            }
        }
        this.primaryMonitor = this.monitors[this.primaryIndex];
        this.bottomMonitor = this.monitors[this.bottomIndex];
    },

    _updateHotCorners: function() {
        // destroy old hot corners
        for (let i = 0; i < this._hotCorners.length; i++)
            this._hotCorners[i].destroy();
        this._hotCorners = [];

        // build new hot corners
        for (let i = 0; i < this.monitors.length; i++) {
            if (i == this.primaryIndex)
                continue;

            let monitor = this.monitors[i];
            let cornerX = this._rtl ? monitor.x + monitor.width : monitor.x;
            let cornerY = monitor.y;

            let haveTopLeftCorner = true;

            // Check if we have a top left (right for RTL) corner.
            // I.e. if there is no monitor directly above or to the left(right)
            let besideX = this._rtl ? monitor.x + 1 : cornerX - 1;
            let besideY = cornerY;
            let aboveX = cornerX;
            let aboveY = cornerY - 1;

            for (let j = 0; j < this.monitors.length; j++) {
                if (i == j)
                    continue;
                let otherMonitor = this.monitors[j];
                if (besideX >= otherMonitor.x &&
                    besideX < otherMonitor.x + otherMonitor.width &&
                    besideY >= otherMonitor.y &&
                    besideY < otherMonitor.y + otherMonitor.height) {
                    haveTopLeftCorner = false;
                    break;
                }
                if (aboveX >= otherMonitor.x &&
                    aboveX < otherMonitor.x + otherMonitor.width &&
                    aboveY >= otherMonitor.y &&
                    aboveY < otherMonitor.y + otherMonitor.height) {
                    haveTopLeftCorner = false;
                    break;
                }
            }

            if (!haveTopLeftCorner)
                continue;

            let corner = new HotCorner(this);
            this._hotCorners.push(corner);
            corner.actor.set_position(cornerX, cornerY);
            this.addChrome(corner.actor);
        }
    },

    _updateBoxes: function() {
        this.screenShieldGroup.set_position(0, 0);
        this.screenShieldGroup.set_size(global.screen_width, global.screen_height);

        this.panelBox.set_position(this.primaryMonitor.x, this.primaryMonitor.y);
        this.panelBox.set_size(this.primaryMonitor.width, -1);

        if (this.keyboardIndex < 0)
            this.keyboardIndex = this.primaryIndex;

        this.trayBox.set_position(this.bottomMonitor.x,
                                  this.bottomMonitor.y + this.bottomMonitor.height);
        this.trayBox.set_size(this.bottomMonitor.width, -1);

        // Set trayBox's clip to show things above it, but not below
        // it (so it's not visible behind the keyboard). The exact
        // height of the clip doesn't matter, as long as it's taller
        // than any Notification.actor.
        this.trayBox.set_clip(0, -this.bottomMonitor.height,
                              this.bottomMonitor.width, this.bottomMonitor.height);
    },

    _panelBoxChanged: function() {
        this.emit('panel-box-changed');
        this._updatePanelBarriers();
    },

    _updatePanelBarriers: function() {
        if (this._leftPanelBarrier)
            global.destroy_pointer_barrier(this._leftPanelBarrier);
        if (this._rightPanelBarrier)
            global.destroy_pointer_barrier(this._rightPanelBarrier);

        if (this.panelBox.height) {
            let primary = this.primaryMonitor;
            this._leftPanelBarrier =
                global.create_pointer_barrier(primary.x, primary.y,
                                              primary.x, primary.y + this.panelBox.height,
                                              1 /* BarrierPositiveX */);
            this._rightPanelBarrier =
                global.create_pointer_barrier(primary.x + primary.width, primary.y,
                                              primary.x + primary.width, primary.y + this.panelBox.height,
                                              4 /* BarrierNegativeX */);
        } else {
            this._leftPanelBarrier = 0;
            this._rightPanelBarrier = 0;
        }
    },

    _monitorsChanged: function() {
        this._updateMonitors();
        this._updateBoxes();
        this._updateHotCorners();
        this._updateFullscreen();
        this._updateVisibility();
        this._queueUpdateRegions();

        this.emit('monitors-changed');
    },

    _isAboveOrBelowPrimary: function(monitor) {
        let primary = this.monitors[this.primaryIndex];
        let monitorLeft = monitor.x, monitorRight = monitor.x + monitor.width;
        let primaryLeft = primary.x, primaryRight = primary.x + primary.width;

        if ((monitorLeft >= primaryLeft && monitorLeft < primaryRight) ||
            (monitorRight > primaryLeft && monitorRight <= primaryRight) ||
            (primaryLeft >= monitorLeft && primaryLeft < monitorRight) ||
            (primaryRight > monitorLeft && primaryRight <= monitorRight))
            return true;

        return false;
    },

    get currentMonitor() {
        let index = global.screen.get_current_monitor();
        return this.monitors[index];
    },

    get keyboardMonitor() {
        return this.monitors[this.keyboardIndex];
    },

    get focusIndex() {
        let i = Main.layoutManager.primaryIndex;

        if (global.stage_input_mode == Shell.StageInputMode.FOCUSED ||
            global.stage_input_mode == Shell.StageInputMode.FULLSCREEN) {
            let focusActor = global.stage.key_focus;
            if (focusActor)
                i = this.findIndexForActor(focusActor);
        } else {
            let focusWindow = global.display.focus_window;
            if (focusWindow)
                i = this.findIndexForWindow(focusWindow);
        }

        return i;
    },

    get focusMonitor() {
        return this.monitors[this.focusIndex];
    },

    set keyboardIndex(v) {
        this._keyboardIndex = v;
        this.keyboardBox.set_position(this.keyboardMonitor.x,
                                      this.keyboardMonitor.y + this.keyboardMonitor.height);
        this.keyboardBox.set_size(this.keyboardMonitor.width, -1);
    },

    get keyboardIndex() {
        return this._keyboardIndex;
    },

    _acquireRootBackground: function() {
        let rootpmap = Shell.util_get_root_background();
        let texture = ClutterX11.TexturePixmap.new_with_pixmap(rootpmap);
        // The texture size might not match the screen size, for example
        // if the session has a different XRandR configuration than the greeter
        texture.x = 0;
        texture.y = 0;
        texture.width = global.screen_width;
        texture.height = global.screen_height;
        texture.set_automatic(true);

        this._rootTexture = texture;
    },

    // Startup Animations
    //
    // We have two different animations, depending on whether we're a greeter
    // or a normal session.
    //
    // In the greeter, we want to animate the panel from the top, and smoothly
    // fade the login dialog on top of whatever plymouth left on screen, which we
    // grab as a X11 texture_from_pixmap.
    // Here we just have the code to animate the panel, the login dialog animation
    // is handled by modalDialog.js
    //
    // In a normal session, we want to take the root background, which now holds
    // the final frame of the GDM greeter, and slide it from the bottom, while
    // at the same time scaling the UI contents of the new shell on top of the
    // stage background.
    //
    // Usually, we don't want to paint the stage background color because the
    // MetaBackgroundActor inside global.window_group covers the entirety of the
    // screen. So, we set no_clear_hint at the end of the animation.

    _prepareStartupAnimation: function() {
        // Set ourselves to FULLSCREEN input mode while the animation is running
        // so events don't get delivered to X11 windows (which are distorted by the animation)
        global.stage_input_mode = Shell.StageInputMode.FULLSCREEN;

        this._acquireRootBackground();

        if (Main.sessionMode.isGreeter) {
            global.stage.insert_child_below(this._rootTexture, null);

            this._panelBox.translation_y = -this._panelBox.height;
        } else {
            global.stage.insert_child_above(this._rootTexture, null);

            this.uiGroup.set_pivot_point(0.5, 0.5);
            this.uiGroup.scale_x = this.uiGroup.scale_y = 0;
        }
    },

    startupAnimation: function() {
        if (Main.sessionMode.isGreeter)
            this._startupAnimationGreeter();
        else
            this._startupAnimationSession();
    },

    _startupAnimationGreeter: function() {
        // Don't animate the strut
        this._freezeUpdateRegions();

        Tweener.addTween(this._panelBox,
                         { translation_y: 0,
                           time: STARTUP_ANIMATION_TIME,
                           transition: 'easeOutQuad',
                           onComplete: this._startupAnimationComplete,
                           onCompleteScope: this });
    },

    _startupAnimationSession: function() {
        // Don't animate the strut
        this._freezeUpdateRegions();

        Tweener.addTween(this._rootTexture,
                         { translation_y: -global.screen_height,
                           time: STARTUP_ANIMATION_TIME,
                           transition: 'linear' });

        Tweener.addTween(this.uiGroup,
                         { scale_x: 1,
                           scale_y: 1,
                           time: STARTUP_ANIMATION_TIME,
                           transition: 'easeOutQuad',
                           onComplete: this._startupAnimationComplete,
                           onCompleteScope: this });
    },

    _startupAnimationComplete: function() {
        // At this point, the UI group is covering everything, so
        // we no longer need to clear the stage
        global.stage.no_clear_hint = true;

        global.stage_input_mode = Shell.StageInputMode.NORMAL;

        this._rootTexture.destroy();
        this._rootTexture = null;

        this.emit('panel-box-changed');
        this._thawUpdateRegions();
    },

    showKeyboard: function () {
        this.keyboardBox.raise_top();
        Tweener.addTween(this.keyboardBox,
                         { anchor_y: this.keyboardBox.height,
                           time: KEYBOARD_ANIMATION_TIME,
                           transition: 'easeOutQuad',
                           onComplete: this._showKeyboardComplete,
                           onCompleteScope: this
                         });

        if (this.keyboardIndex == this.bottomIndex) {
            Tweener.addTween(this.trayBox,
                             { anchor_y: this.keyboardBox.height,
                               time: KEYBOARD_ANIMATION_TIME,
                               transition: 'easeOutQuad'
                             });
        }

        this.emit('keyboard-visible-changed', true);
    },

    _showKeyboardComplete: function() {
        // Poke Chrome to update the input shape; it doesn't notice
        // anchor point changes
        this._updateRegions();

        this._keyboardHeightNotifyId = this.keyboardBox.connect('notify::height', Lang.bind(this, function () {
            this.keyboardBox.anchor_y = this.keyboardBox.height;
            if (this.keyboardIndex == this.bottomIndex)
                this.trayBox.anchor_y = this.keyboardBox.height;
        }));
    },

    hideKeyboard: function (immediate) {
        if (this._keyboardHeightNotifyId) {
            this.keyboardBox.disconnect(this._keyboardHeightNotifyId);
            this._keyboardHeightNotifyId = 0;
        }
        Tweener.addTween(this.keyboardBox,
                         { anchor_y: 0,
                           time: immediate ? 0 : KEYBOARD_ANIMATION_TIME,
                           transition: 'easeInQuad',
                           onComplete: this._hideKeyboardComplete,
                           onCompleteScope: this
                         });

        if (this.keyboardIndex == this.bottomIndex) {
            Tweener.addTween(this.trayBox,
                             { anchor_y: 0,
                               time: immediate ? 0 : KEYBOARD_ANIMATION_TIME,
                               transition: 'easeOutQuad'
                             });
        }

        this.emit('keyboard-visible-changed', false);
    },

    _hideKeyboardComplete: function() {
        this._updateRegions();
    },

    // addChrome:
    // @actor: an actor to add to the chrome
    // @params: (optional) additional params
    //
    // Adds @actor to the chrome, and (unless %affectsInputRegion in
    // @params is %false) extends the input region to include it.
    // Changes in @actor's size, position, and visibility will
    // automatically result in appropriate changes to the input
    // region.
    //
    // If %affectsStruts in @params is %true (and @actor is along a
    // screen edge), then @actor's size and position will also affect
    // the window manager struts. Changes to @actor's visibility will
    // NOT affect whether or not the strut is present, however.
    //
    // If %trackFullscreen in @params is %true, the actor's visibility
    // will be bound to the presence of fullscreen windows on the same
    // monitor (it will be hidden whenever a fullscreen window is visible,
    // and shown otherwise)
    addChrome: function(actor, params) {
        this.uiGroup.add_actor(actor);
        this._trackActor(actor, params);
    },

    // trackChrome:
    // @actor: a descendant of the chrome to begin tracking
    // @params: parameters describing how to track @actor
    //
    // Tells the chrome to track @actor, which must be a descendant
    // of an actor added via addChrome(). This can be used to extend the
    // struts or input region to cover specific children.
    //
    // @params can have any of the same values as in addChrome(),
    // though some possibilities don't make sense. By default, @actor has
    // the same params as its chrome ancestor.
    trackChrome: function(actor, params) {
        let ancestor = actor.get_parent();
        let index = this._findActor(ancestor);
        while (ancestor && index == -1) {
            ancestor = ancestor.get_parent();
            index = this._findActor(ancestor);
        }
        if (!ancestor)
            throw new Error('actor is not a descendent of a chrome actor');

        let ancestorData = this._trackedActors[index];
        if (!params)
            params = {};
        // We can't use Params.parse here because we want to drop
        // the extra values like ancestorData.actor
        for (let prop in defaultParams) {
            if (!params.hasOwnProperty(prop))
                params[prop] = ancestorData[prop];
        }

        this._trackActor(actor, params);
    },

    // untrackChrome:
    // @actor: an actor previously tracked via trackChrome()
    //
    // Undoes the effect of trackChrome()
    untrackChrome: function(actor) {
        this._untrackActor(actor);
    },

    // removeChrome:
    // @actor: a chrome actor
    //
    // Removes @actor from the chrome
    removeChrome: function(actor) {
        this.uiGroup.remove_actor(actor);
        this._untrackActor(actor);
    },

    _findActor: function(actor) {
        for (let i = 0; i < this._trackedActors.length; i++) {
            let actorData = this._trackedActors[i];
            if (actorData.actor == actor)
                return i;
        }
        return -1;
    },

    _trackActor: function(actor, params) {
        if (this._findActor(actor) != -1)
            throw new Error('trying to re-track existing chrome actor');

        let actorData = Params.parse(params, defaultParams);
        actorData.actor = actor;
        actorData.isToplevel = actor.get_parent() == this.uiGroup;
        actorData.visibleId = actor.connect('notify::visible',
                                            Lang.bind(this, this._queueUpdateRegions));
        actorData.allocationId = actor.connect('notify::allocation',
                                               Lang.bind(this, this._queueUpdateRegions));
        actorData.parentSetId = actor.connect('parent-set',
                                              Lang.bind(this, this._actorReparented));
        // Note that destroying actor will unset its parent, so we don't
        // need to connect to 'destroy' too.

        this._trackedActors.push(actorData);
        this._queueUpdateRegions();
    },

    _untrackActor: function(actor) {
        let i = this._findActor(actor);

        if (i == -1)
            return;
        let actorData = this._trackedActors[i];

        this._trackedActors.splice(i, 1);
        actor.disconnect(actorData.visibleId);
        actor.disconnect(actorData.allocationId);
        actor.disconnect(actorData.parentSetId);

        this._queueUpdateRegions();
    },

    _actorReparented: function(actor, oldParent) {
        let newParent = actor.get_parent();
        if (!newParent) {
            this._untrackActor(actor);
        } else {
            let i = this._findActor(actor);
            let actorData = this._trackedActors[i];
            actorData.isToplevel = (newParent == this.uiGroup);
        }
    },

    _updateVisibility: function() {
        for (let i = 0; i < this._trackedActors.length; i++) {
            let actorData = this._trackedActors[i], visible;
            if (!actorData.trackFullscreen)
                continue;
            if (!actorData.isToplevel)
                continue;

            if (this._inOverview || !Main.sessionMode.hasWindows)
                visible = true;
            else if (this.findMonitorForActor(actorData.actor).inFullscreen)
                visible = false;
            else
                visible = true;
            actorData.actor.visible = visible;
        }
    },

    _findMonitorForRect: function(x, y, w, h) {
        // First look at what monitor the center of the rectangle is at
        let cx = x + w/2;
        let cy = y + h/2;
        for (let i = 0; i < this.monitors.length; i++) {
            let monitor = this.monitors[i];
            if (cx >= monitor.x && cx < monitor.x + monitor.width &&
                cy >= monitor.y && cy < monitor.y + monitor.height)
                return i;
        }
        // If the center is not on a monitor, return the first overlapping monitor
        for (let i = 0; i < this.monitors.length; i++) {
            let monitor = this.monitors[i];
            if (x + w > monitor.x && x < monitor.x + monitor.width &&
                y + h > monitor.y && y < monitor.y + monitor.height)
                return i;
        }
        // otherwise on no monitor
        return -1;
    },

    findIndexForWindow: function(window) {
        let rect = window.get_input_rect();
        let i = this._findMonitorForRect(rect.x, rect.y, rect.width, rect.height);
        if (i >= 0)
            return i;
        return this.primaryIndex; // Not on any monitor, pretend its on the primary
    },

    // This call guarantees that we return some monitor to simplify usage of it
    // In practice all tracked actors should be visible on some monitor anyway
    findIndexForActor: function(actor) {
        let [x, y] = actor.get_transformed_position();
        let [w, h] = actor.get_transformed_size();
        let i = this._findMonitorForRect(x, y, w, h);
        if (i >= 0)
            return i;
        return this.primaryIndex; // Not on any monitor, pretend its on the primary
    },

    findMonitorForWindow: function(window) {
        let rect = window.get_input_rect();
        let i = this._findMonitorForRect(rect.x, rect.y, rect.width, rect.height);
        if (i >= 0)
            return this.monitors[i];
        else
            return null;
    },

    findMonitorForActor: function(actor) {
        return this.monitors[this.findIndexForActor(actor)];
    },

    _queueUpdateRegions: function() {
        if (!this._updateRegionIdle && !this._freezeUpdateCount)
            this._updateRegionIdle = Mainloop.idle_add(Lang.bind(this, this._updateRegions),
                                                       Meta.PRIORITY_BEFORE_REDRAW);
    },

    _freezeUpdateRegions: function() {
        if (this._updateRegionIdle)
            this._updateRegions();
        this._freezeUpdateCount++;
    },

    _thawUpdateRegions: function() {
        this._freezeUpdateCount--;
        this._queueUpdateRegions();
    },

    _updateFullscreen: function() {
        let windows = Main.getWindowActorsForWorkspace(global.screen.get_active_workspace_index());

        // Reset all monitors to not fullscreen
        for (let i = 0; i < this.monitors.length; i++)
            this.monitors[i].inFullscreen = false;

        // Ordinary chrome should be visible unless there is a window
        // with layer FULLSCREEN, or a window with layer
        // OVERRIDE_REDIRECT that covers the whole screen.
        // ('override_redirect' is not actually a layer above all
        // other windows, but this seems to be how mutter treats it
        // currently...) If we wanted to be extra clever, we could
        // figure out when an OVERRIDE_REDIRECT window was trying to
        // partially overlap us, and then adjust the input region and
        // our clip region accordingly...

        // @windows is sorted bottom to top.

        for (let i = windows.length - 1; i > -1; i--) {
            let window = windows[i];
            let metaWindow = window.meta_window;
            let layer = metaWindow.get_layer();

            // Skip minimized windows
            if (!window.showing_on_its_workspace())
                continue;

            if (layer == Meta.StackLayer.FULLSCREEN) {
                let monitor = this.findMonitorForWindow(metaWindow);
                if (monitor)
                    monitor.inFullscreen = true;
            }
            if (layer == Meta.StackLayer.OVERRIDE_REDIRECT) {
                // Check whether the window is screen sized
                let isScreenSized =
                    (window.x == 0 && window.y == 0 &&
                    window.width == global.screen_width &&
                    window.height == global.screen_height);

                if (isScreenSized) {
                    for (let i = 0; i < this.monitors.length; i++)
                        this.monitors[i].inFullscreen = true;
                }

                // Or whether it is monitor sized
                let monitor = this.findMonitorForWindow(metaWindow);
                if (monitor &&
                    window.x <= monitor.x &&
                    window.x + window.width >= monitor.x + monitor.width &&
                    window.y <= monitor.y &&
                    window.y + window.height >= monitor.y + monitor.height)
                    monitor.inFullscreen = true;
            } else
                break;
        }
    },

    _windowsRestacked: function() {
        let wasInFullscreen = [];
        for (let i = 0; i < this.monitors.length; i++)
            wasInFullscreen[i] = this.monitors[i].inFullscreen;

        let primaryWasInFullscreen = this.primaryMonitor.inFullscreen;

        this._updateFullscreen();

        let changed = false;
        for (let i = 0; i < wasInFullscreen.length; i++) {
            if (wasInFullscreen[i] != this.monitors[i].inFullscreen) {
                changed = true;
                break;
            }
        }

        if (changed) {
            this._updateVisibility();
            this._queueUpdateRegions();
        }

        if (primaryWasInFullscreen != this.primaryMonitor.inFullscreen) {
            this.emit('primary-fullscreen-changed', this.primaryMonitor.inFullscreen);
        }
    },

    _updateRegions: function() {
        let rects = [], struts = [], i;

        if (this._updateRegionIdle) {
            Mainloop.source_remove(this._updateRegionIdle);
            delete this._updateRegionIdle;
        }

        for (i = 0; i < this._trackedActors.length; i++) {
            let actorData = this._trackedActors[i];
            if (!actorData.affectsInputRegion && !actorData.affectsStruts)
                continue;

            let [x, y] = actorData.actor.get_transformed_position();
            let [w, h] = actorData.actor.get_transformed_size();
            x = Math.round(x);
            y = Math.round(y);
            w = Math.round(w);
            h = Math.round(h);
            let rect = new Meta.Rectangle({ x: x, y: y, width: w, height: h});

            if (actorData.affectsInputRegion &&
                actorData.actor.get_paint_visibility() &&
                !this.uiGroup.get_skip_paint(actorData.actor))
                rects.push(rect);

            if (!actorData.affectsStruts)
                continue;

            // Limit struts to the size of the screen
            let x1 = Math.max(x, 0);
            let x2 = Math.min(x + w, global.screen_width);
            let y1 = Math.max(y, 0);
            let y2 = Math.min(y + h, global.screen_height);

            // NetWM struts are not really powerful enought to handle
            // a multi-monitor scenario, they only describe what happens
            // around the outer sides of the full display region. However
            // it can describe a partial region along each side, so
            // we can support having the struts only affect the
            // primary monitor. This should be enough as we only have
            // chrome affecting the struts on the primary monitor so
            // far.
            //
            // Metacity wants to know what side of the screen the
            // strut is considered to be attached to. If the actor is
            // only touching one edge, or is touching the entire
            // border of the primary monitor, then it's obvious which
            // side to call it. If it's in a corner, we pick a side
            // arbitrarily. If it doesn't touch any edges, or it spans
            // the width/height across the middle of the screen, then
            // we don't create a strut for it at all.
            let side;
            let primary = this.primaryMonitor;
            if (x1 <= primary.x && x2 >= primary.x + primary.width) {
                if (y1 <= primary.y)
                    side = Meta.Side.TOP;
                else if (y2 >= primary.y + primary.height)
                    side = Meta.Side.BOTTOM;
                else
                    continue;
            } else if (y1 <= primary.y && y2 >= primary.y + primary.height) {
                if (x1 <= 0)
                    side = Meta.Side.LEFT;
                else if (x2 >= primary.x + primary.width)
                    side = Meta.Side.RIGHT;
                else
                    continue;
            } else if (x1 <= 0)
                side = Meta.Side.LEFT;
            else if (y1 <= 0)
                side = Meta.Side.TOP;
            else if (x2 >= global.screen_width)
                side = Meta.Side.RIGHT;
            else if (y2 >= global.screen_height)
                side = Meta.Side.BOTTOM;
            else
                continue;

            // Ensure that the strut rects goes all the way to the screen edge,
            // as this really what mutter expects.
            switch (side) {
            case Meta.Side.TOP:
                y1 = 0;
                break;
            case Meta.Side.BOTTOM:
                y2 = global.screen_height;
                break;
            case Meta.Side.LEFT:
                x1 = 0;
                break;
            case Meta.Side.RIGHT:
                x2 = global.screen_width;
                break;
            }

            let strutRect = new Meta.Rectangle({ x: x1, y: y1, width: x2 - x1, height: y2 - y1});
            let strut = new Meta.Strut({ rect: strutRect, side: side });
            struts.push(strut);
        }

        global.set_stage_input_region(rects);

        let screen = global.screen;
        for (let w = 0; w < screen.n_workspaces; w++) {
            let workspace = screen.get_workspace_by_index(w);
            workspace.set_builtin_struts(struts);
        }

        return false;
    }
});
Signals.addSignalMethods(LayoutManager.prototype);


// HotCorner:
//
// This class manages a "hot corner" that can toggle switching to
// overview.
const HotCorner = new Lang.Class({
    Name: 'HotCorner',

    _init : function() {
        // We use this flag to mark the case where the user has entered the
        // hot corner and has not left both the hot corner and a surrounding
        // guard area (the "environs"). This avoids triggering the hot corner
        // multiple times due to an accidental jitter.
        this._entered = false;

        this.actor = new Clutter.Group({ name: 'hot-corner-environs',
                                         width: 3,
                                         height: 3,
                                         reactive: true });

        this._corner = new Clutter.Rectangle({ name: 'hot-corner',
                                               width: 1,
                                               height: 1,
                                               opacity: 0,
                                               reactive: true });
        this._corner._delegate = this;

        this.actor.add_actor(this._corner);

        if (Clutter.get_default_text_direction() == Clutter.TextDirection.RTL) {
            this._corner.set_position(this.actor.width - this._corner.width, 0);
            this.actor.set_anchor_point_from_gravity(Clutter.Gravity.NORTH_EAST);
        } else {
            this._corner.set_position(0, 0);
        }

        this._activationTime = 0;

        this.actor.connect('leave-event',
                           Lang.bind(this, this._onEnvironsLeft));

        // Clicking on the hot corner environs should result in the
        // same behavior as clicking on the hot corner.
        this.actor.connect('button-release-event',
                           Lang.bind(this, this._onCornerClicked));

        // In addition to being triggered by the mouse enter event,
        // the hot corner can be triggered by clicking on it. This is
        // useful if the user wants to undo the effect of triggering
        // the hot corner once in the hot corner.
        this._corner.connect('enter-event',
                             Lang.bind(this, this._onCornerEntered));
        this._corner.connect('button-release-event',
                             Lang.bind(this, this._onCornerClicked));
        this._corner.connect('leave-event',
                             Lang.bind(this, this._onCornerLeft));

        // Cache the three ripples instead of dynamically creating and destroying them.
        this._ripple1 = new St.BoxLayout({ style_class: 'ripple-box', opacity: 0, visible: false });
        this._ripple2 = new St.BoxLayout({ style_class: 'ripple-box', opacity: 0, visible: false });
        this._ripple3 = new St.BoxLayout({ style_class: 'ripple-box', opacity: 0, visible: false });

        Main.uiGroup.add_actor(this._ripple1);
        Main.uiGroup.add_actor(this._ripple2);
        Main.uiGroup.add_actor(this._ripple3);
    },

    destroy: function() {
        this.actor.destroy();
    },

    _animRipple : function(ripple, delay, time, startScale, startOpacity, finalScale) {
        // We draw a ripple by using a source image and animating it scaling
        // outwards and fading away. We want the ripples to move linearly
        // or it looks unrealistic, but if the opacity of the ripple goes
        // linearly to zero it fades away too quickly, so we use Tweener's
        // 'onUpdate' to give a non-linear curve to the fade-away and make
        // it more visible in the middle section.

        ripple._opacity = startOpacity;

        if (ripple.get_text_direction() == Clutter.TextDirection.RTL)
            ripple.set_anchor_point_from_gravity(Clutter.Gravity.NORTH_EAST);

        ripple.visible = true;
        ripple.opacity = 255 * Math.sqrt(startOpacity);
        ripple.scale_x = ripple.scale_y = startScale;

        let [x, y] = this._corner.get_transformed_position();
        ripple.x = x;
        ripple.y = y;

        Tweener.addTween(ripple, { _opacity: 0,
                                   scale_x: finalScale,
                                   scale_y: finalScale,
                                   delay: delay,
                                   time: time,
                                   transition: 'linear',
                                   onUpdate: function() { ripple.opacity = 255 * Math.sqrt(ripple._opacity); },
                                   onComplete: function() { ripple.visible = false; } });
    },

    rippleAnimation: function() {
        // Show three concentric ripples expanding outwards; the exact
        // parameters were found by trial and error, so don't look
        // for them to make perfect sense mathematically

        //                              delay  time  scale opacity => scale
        this._animRipple(this._ripple1, 0.0,   0.83,  0.25,  1.0,     1.5);
        this._animRipple(this._ripple2, 0.05,  1.0,   0.0,   0.7,     1.25);
        this._animRipple(this._ripple3, 0.35,  1.0,   0.0,   0.3,     1);
    },

    handleDragOver: function(source, actor, x, y, time) {
        if (source != Main.xdndHandler)
            return DND.DragMotionResult.CONTINUE;

        if (!Main.overview.visible && !Main.overview.animationInProgress) {
            this.rippleAnimation();
            Main.overview.showTemporarily();
            Main.overview.beginItemDrag(actor);
        }

        return DND.DragMotionResult.CONTINUE;
    },

    _onCornerEntered : function() {
        if (!this._entered) {
            this._entered = true;
            if (!Main.overview.animationInProgress) {
                this._activationTime = Date.now() / 1000;

                this.rippleAnimation();
                Main.overview.toggle();
            }
        }
        return false;
    },

    _onCornerClicked : function() {
        if (this.shouldToggleOverviewOnClick())
            Main.overview.toggle();
        return true;
    },

    _onCornerLeft : function(actor, event) {
        if (event.get_related() != this.actor)
            this._entered = false;
        // Consume event, otherwise this will confuse onEnvironsLeft
        return true;
    },

    _onEnvironsLeft : function(actor, event) {
        if (event.get_related() != this._corner)
            this._entered = false;
        return false;
    },

    // Checks if the Activities button is currently sensitive to
    // clicks. The first call to this function within the
    // HOT_CORNER_ACTIVATION_TIMEOUT time of the hot corner being
    // triggered will return false. This avoids opening and closing
    // the overview if the user both triggered the hot corner and
    // clicked the Activities button.
    shouldToggleOverviewOnClick: function() {
        if (Main.overview.animationInProgress)
            return false;
        if (this._activationTime == 0 || Date.now() / 1000 - this._activationTime > HOT_CORNER_ACTIVATION_TIMEOUT)
            return true;
        return false;
    }
});
