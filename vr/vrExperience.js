import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { VolumeSlider } from './volumeSlider.js';
const DEFAULT_SLIDER_POSITION = new THREE.Vector3(1.5, 1.7, -1.45);
const DEFAULT_VOLUME = 0.3;
/**
 * Drop-in immersive-VR support for an existing three.js scene:
 * `Enter VR` button, `local-floor` reference space, controller rays, `dom-overlay`,
 * ambient audio and a 3D volume slider that works with controllers and pointer input.
 *
 * The host app keeps ownership of its scene, camera, renderer and UI. Call `update()` once per
 * frame and `dispose()` when tearing the scene down.
 */
export class VRExperience {
    scene;
    camera;
    renderer;
    options;
    referenceSpaceType;
    controllers = [];
    ownsControllers;
    controllerCleanup = [];
    raycaster = new THREE.Raycaster();
    sliderDragPlane = new THREE.Plane();
    pointerNdc = new THREE.Vector2();
    volumeSlider;
    audioListener;
    ambientSound;
    ambientVolume = DEFAULT_VOLUME;
    vrButton;
    active = false;
    pointerDragging = false;
    pointerId = null;
    draggingController = null;
    constructor(scene, camera, renderer, options = {}) {
        this.scene = scene;
        this.camera = camera;
        this.renderer = renderer;
        this.options = options;
        this.referenceSpaceType = options.referenceSpaceType ?? 'local-floor';
        this.ambientVolume = THREE.MathUtils.clamp(options.initialVolume ?? DEFAULT_VOLUME, 0, 1);
        renderer.xr.enabled = true;
        // Fixed world coordinates assume the floor is at y = 0.
        renderer.xr.setReferenceSpaceType(this.referenceSpaceType);
        if (options.volumeSlider !== false)
            this.initVolumeSlider();
        this.initAudio();
        if (this.volumeSlider)
            this.initPointerControls();
        const providedControllers = options.controllers ?? [];
        this.ownsControllers = providedControllers.length === 0;
        this.initControllers(providedControllers);
        this.initVR();
    }
    /** The `Enter VR` button, available after construction. */
    get button() {
        return this.vrButton ?? null;
    }
    get volume() {
        return this.ambientVolume;
    }
    /** Updates the audio volume (0..1) and keeps the 3D slider in sync. */
    setVolume(value) {
        const clamped = THREE.MathUtils.clamp(value, 0, 1);
        this.ambientVolume = clamped;
        this.ambientSound?.setVolume(clamped);
        this.volumeSlider?.setValue(clamped);
        this.options.onVolumeChange?.(clamped);
    }
    /** Call once per frame; only does work while the slider is being dragged. */
    update() {
        this.updateSliderDrag();
    }
    dispose() {
        this.renderer.domElement.removeEventListener('pointerdown', this.handlePointerDown);
        this.renderer.domElement.removeEventListener('pointermove', this.handlePointerMove);
        this.renderer.domElement.removeEventListener('pointerup', this.handlePointerUp);
        this.renderer.domElement.removeEventListener('pointercancel', this.handlePointerUp);
        if (this.vrButton) {
            this.vrButton.removeEventListener('click', this.handleVRButtonClick);
            this.vrButton.remove();
        }
        this.options.exitButton?.removeEventListener('click', this.handleExitClick);
        this.renderer.xr.removeEventListener('sessionstart', this.handleSessionStart);
        this.renderer.xr.removeEventListener('sessionend', this.handleSessionEnd);
        this.controllerCleanup.forEach((cleanup) => cleanup());
        this.controllerCleanup.length = 0;
        if (this.ownsControllers) {
            this.controllers.forEach((controller) => this.scene.remove(controller));
        }
        this.controllers.length = 0;
        this.ambientSound?.pause();
        if (this.audioListener)
            this.camera.remove(this.audioListener);
        if (this.volumeSlider) {
            this.scene.remove(this.volumeSlider.group);
            this.volumeSlider.dispose();
            this.volumeSlider = undefined;
        }
    }
    initVolumeSlider() {
        const position = (this.options.sliderPosition ?? DEFAULT_SLIDER_POSITION).clone();
        this.volumeSlider = new VolumeSlider(this.ambientVolume);
        this.volumeSlider.group.position.copy(position);
        this.scene.add(this.volumeSlider.group);
        this.volumeSlider.group.updateMatrixWorld(true);
        // The slider is unrotated, so its drag plane is parallel to the viewer.
        this.sliderDragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), position);
        if (this.options.speakerIconUrl)
            this.initSpeakerIcon(this.options.speakerIconUrl);
    }
    initSpeakerIcon(url) {
        const loader = new THREE.TextureLoader();
        loader.load(url, (texture) => {
            texture.colorSpace = THREE.SRGBColorSpace;
            this.volumeSlider?.setSpeakerTexture(texture);
        }, undefined, (error) => console.warn('Could not load the speaker icon:', error));
    }
    initAudio() {
        const url = this.options.ambientSoundUrl;
        if (!url)
            return;
        this.audioListener = new THREE.AudioListener();
        this.camera.add(this.audioListener);
        this.ambientSound = new THREE.Audio(this.audioListener);
        const loader = new THREE.AudioLoader();
        loader.load(url, (buffer) => {
            const sound = this.ambientSound;
            if (!sound)
                return;
            sound.setBuffer(buffer);
            sound.setLoop(true);
            sound.setVolume(this.ambientVolume);
            // The buffer can finish loading after the VR session has already started.
            if (this.active)
                this.startAmbientSound();
        }, undefined, (error) => console.warn('Could not load the ambient sound:', error));
    }
    initPointerControls() {
        const canvas = this.renderer.domElement;
        canvas.style.touchAction = 'none';
        canvas.addEventListener('pointerdown', this.handlePointerDown);
        canvas.addEventListener('pointermove', this.handlePointerMove);
        canvas.addEventListener('pointerup', this.handlePointerUp);
        canvas.addEventListener('pointercancel', this.handlePointerUp);
    }
    initControllers(provided) {
        const controllers = provided.length > 0 ? provided : [this.renderer.xr.getController(0), this.renderer.xr.getController(1)];
        controllers.forEach((controller) => {
            if (this.ownsControllers) {
                // Hidden outside a session so the helper ray is not drawn in flat mode.
                controller.visible = false;
                controller.add(this.createControllerRay());
                this.scene.add(controller);
            }
            const onSelectStart = () => this.onSliderGrab(controller);
            const onSelectEnd = () => this.onSliderRelease(controller);
            controller.addEventListener('selectstart', onSelectStart);
            controller.addEventListener('selectend', onSelectEnd);
            this.controllerCleanup.push(() => {
                controller.removeEventListener('selectstart', onSelectStart);
                controller.removeEventListener('selectend', onSelectEnd);
            });
            this.controllers.push(controller);
        });
    }
    createControllerRay() {
        const geometry = new THREE.BufferGeometry().setFromPoints([
            new THREE.Vector3(0, 0, 0),
            new THREE.Vector3(0, 0, -1),
        ]);
        const material = new THREE.LineBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.4,
        });
        const line = new THREE.Line(geometry, material);
        line.scale.z = 2;
        return line;
    }
    initVR() {
        if (this.options.createButton !== false) {
            const sessionInit = {
                requiredFeatures: [this.referenceSpaceType],
                optionalFeatures: ['dom-overlay'],
                ...(this.options.overlayRoot ? { domOverlay: { root: this.options.overlayRoot } } : {}),
            };
            const button = VRButton.createButton(this.renderer, sessionInit);
            (this.options.buttonParent ?? document.body).appendChild(button);
            this.vrButton = button;
            // Unlock the AudioContext inside the user gesture; playback waits for sessionstart.
            button.addEventListener('click', this.handleVRButtonClick);
        }
        this.options.exitButton?.addEventListener('click', this.handleExitClick);
        this.renderer.xr.addEventListener('sessionstart', this.handleSessionStart);
        this.renderer.xr.addEventListener('sessionend', this.handleSessionEnd);
        void this.reportSupport();
    }
    async reportSupport() {
        const status = this.options.statusElement;
        if (!status)
            return;
        const showFallback = (message) => {
            status.textContent = message;
            status.dataset.state = 'error';
        };
        if (!navigator.xr) {
            showFallback('Immersive VR is not available: this browser has no WebXR support. Open the page over HTTPS in a WebXR-capable headset browser (for example Meta Quest Browser). The flat 3D view and buttons below still work.');
            return;
        }
        try {
            const supported = await navigator.xr.isSessionSupported('immersive-vr');
            if (!supported) {
                showFallback('This browser cannot start immersive VR. Serve the page over HTTPS, open it in a WebXR-capable headset browser, and reload. The flat 3D view and buttons below still work.');
                return;
            }
            status.textContent = 'VR ready — press ENTER VR.';
            status.dataset.state = 'ready';
        }
        catch {
            showFallback('WebXR VR support could not be checked. Serve the page over HTTPS and open it in a WebXR-capable headset browser. The flat 3D view and buttons below still work.');
        }
    }
    startAmbientSound() {
        if (!this.active || !this.ambientSound?.buffer)
            return;
        const context = this.audioListener?.context;
        if (!context)
            return;
        void context
            .resume()
            .then(() => {
            if (!this.ambientSound.isPlaying)
                this.ambientSound.play();
        })
            .catch((error) => console.warn('Ambient sound could not start:', error));
    }
    onSliderGrab(controller) {
        if (!this.volumeSlider)
            return;
        this.raycaster.setFromXRController(controller);
        if (this.raycaster.intersectObject(this.volumeSlider.thumb, false).length === 0)
            return;
        this.draggingController = controller;
        this.volumeSlider.setGrabbed(true);
        this.updateSliderDrag();
    }
    onSliderRelease(controller) {
        if (this.draggingController !== controller)
            return;
        this.draggingController = null;
        this.volumeSlider?.setGrabbed(false);
    }
    updateSliderDrag() {
        if (!this.volumeSlider)
            return;
        if (this.draggingController) {
            this.raycaster.setFromXRController(this.draggingController);
        }
        else if (this.pointerDragging) {
            this.raycaster.setFromCamera(this.pointerNdc, this.camera);
        }
        else {
            return;
        }
        const hitPoint = new THREE.Vector3();
        if (!this.raycaster.ray.intersectPlane(this.sliderDragPlane, hitPoint))
            return;
        const localPoint = this.volumeSlider.group.worldToLocal(hitPoint);
        this.setVolume(this.volumeSlider.setValueFromLocalX(localPoint.x));
    }
    updatePointerPosition(event) {
        const rect = this.renderer.domElement.getBoundingClientRect();
        this.pointerNdc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    }
    handlePointerDown = (event) => {
        if (this.draggingController || !this.volumeSlider)
            return;
        this.updatePointerPosition(event);
        this.raycaster.setFromCamera(this.pointerNdc, this.camera);
        if (this.raycaster.intersectObject(this.volumeSlider.thumb, false).length === 0)
            return;
        this.pointerDragging = true;
        this.pointerId = event.pointerId;
        this.volumeSlider.setGrabbed(true);
        this.renderer.domElement.style.cursor = 'grabbing';
        this.renderer.domElement.setPointerCapture(event.pointerId);
        this.updateSliderDrag();
    };
    handlePointerMove = (event) => {
        if (!this.volumeSlider)
            return;
        this.updatePointerPosition(event);
        if (this.pointerDragging && event.pointerId === this.pointerId) {
            this.updateSliderDrag();
            return;
        }
        this.raycaster.setFromCamera(this.pointerNdc, this.camera);
        const hovering = this.raycaster.intersectObject(this.volumeSlider.thumb, false).length > 0;
        this.renderer.domElement.style.cursor = hovering ? 'grab' : '';
    };
    handlePointerUp = (event) => {
        if (!this.pointerDragging || event.pointerId !== this.pointerId)
            return;
        this.pointerDragging = false;
        this.pointerId = null;
        this.volumeSlider?.setGrabbed(false);
        this.renderer.domElement.style.cursor = '';
        if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
            this.renderer.domElement.releasePointerCapture(event.pointerId);
        }
    };
    handleVRButtonClick = () => {
        const context = this.audioListener?.context;
        if (!context)
            return;
        void context.resume().catch((error) => console.warn('AudioContext could not be resumed:', error));
    };
    handleExitClick = () => {
        void this.renderer.xr.getSession()?.end();
    };
    handleSessionStart = () => {
        this.active = true;
        if (this.options.exitButton)
            this.options.exitButton.hidden = false;
        if (this.ownsControllers) {
            this.controllers.forEach((controller) => {
                controller.visible = true;
            });
        }
        this.startAmbientSound();
        this.options.onSessionStart?.();
    };
    handleSessionEnd = () => {
        this.active = false;
        if (this.options.exitButton)
            this.options.exitButton.hidden = true;
        if (this.ownsControllers) {
            this.controllers.forEach((controller) => {
                controller.visible = false;
            });
        }
        this.draggingController = null;
        this.volumeSlider?.setGrabbed(false);
        this.ambientSound?.pause();
        // VRButton hides the dom-overlay root when a session ends; restore the normal UI.
        if (this.options.overlayRoot)
            this.options.overlayRoot.style.display = '';
        this.options.onSessionEnd?.();
    };
}
