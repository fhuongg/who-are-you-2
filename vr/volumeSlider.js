import * as THREE from 'three';
const BAR_WIDTH = 0.4;
const BAR_HEIGHT = 0.03;
const THUMB_RADIUS = 0.035;
const ICON_SIZE = 0.12;
const ICON_GAP = 0.04;
const TRACK_COLOR = 0x374151;
const THUMB_COLOR = 0x87ceeb;
const GRABBED_COLOR = 0xffffff;
/**
 * A horizontal volume slider in the 3D scene. The thumb moves along the local X axis of the
 * group; callers convert controller ray hits into a local X coordinate and map it to 0..1.
 *
 * This copy lives inside the reusable `vr` module so the whole folder can be dropped into
 * another three.js project as-is.
 */
export class VolumeSlider {
    group;
    thumb;
    thumbMaterial;
    speakerMaterial;
    halfWidth = BAR_WIDTH / 2;
    constructor(initialValue = 0.3) {
        this.group = new THREE.Group();
        this.group.name = 'volume-slider';
        const track = new THREE.Mesh(new THREE.BoxGeometry(BAR_WIDTH, BAR_HEIGHT, 0.02), new THREE.MeshBasicMaterial({ color: TRACK_COLOR }));
        track.name = 'volume-slider-track';
        this.group.add(track);
        this.speakerMaterial = new THREE.MeshBasicMaterial({
            transparent: true,
            opacity: 0,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
        const speaker = new THREE.Mesh(new THREE.PlaneGeometry(ICON_SIZE, ICON_SIZE), this.speakerMaterial);
        speaker.name = 'volume-slider-speaker';
        speaker.position.set(-this.halfWidth - ICON_GAP - ICON_SIZE / 2, 0, 0.03);
        this.group.add(speaker);
        this.thumbMaterial = new THREE.MeshBasicMaterial({ color: THUMB_COLOR });
        this.thumb = new THREE.Mesh(new THREE.SphereGeometry(THUMB_RADIUS, 20, 16), this.thumbMaterial);
        this.thumb.name = 'volume-slider-thumb';
        // Sit slightly in front of the track so the thumb is the raycast target.
        this.thumb.position.z = 0.02;
        this.group.add(this.thumb);
        this.setValue(initialValue);
    }
    get value() {
        return (this.thumb.position.x + this.halfWidth) / BAR_WIDTH;
    }
    setValue(value) {
        const clamped = THREE.MathUtils.clamp(value, 0, 1);
        this.thumb.position.x = clamped * BAR_WIDTH - this.halfWidth;
    }
    /** Updates the slider from a local X coordinate and returns the clamped 0..1 value. */
    setValueFromLocalX(localX) {
        this.setValue((localX + this.halfWidth) / BAR_WIDTH);
        return this.value;
    }
    setGrabbed(grabbed) {
        this.thumbMaterial.color.setHex(grabbed ? GRABBED_COLOR : THUMB_COLOR);
        this.thumb.scale.setScalar(grabbed ? 1.25 : 1);
    }
    setSpeakerTexture(texture) {
        this.speakerMaterial.map = texture;
        this.speakerMaterial.opacity = 1;
        this.speakerMaterial.needsUpdate = true;
    }
    dispose() {
        this.group.traverse((child) => {
            if (child instanceof THREE.Mesh) {
                child.geometry.dispose();
                if (Array.isArray(child.material)) {
                    child.material.forEach((material) => material.dispose());
                }
                else {
                    child.material.dispose();
                }
            }
        });
    }
}
