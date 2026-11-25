# Reusable VR module

`VRExperience` adds immersive VR to an existing three.js scene: the `Enter VR` button, a
`local-floor` reference space, controller rays, `dom-overlay`, ambient audio, and a 3D volume
slider that works with controllers and pointer input.

Only `three` (and `three/addons/webxr/VRButton.js`) is required. The module does not depend on
Vite, TypeScript, or this app's persona/voice code.

## Use it in this project

```ts
import { VRExperience } from './vr/index.js';

const vr = new VRExperience(scene, camera, renderer, {
  overlayRoot: uiOverlay, // shown as dom-overlay in the headset when supported
  sliderPosition: new THREE.Vector3(1.5, 1.7, -1.45),
  initialVolume: 0.3,
  ambientSoundUrl: `${import.meta.env.BASE_URL}ambient sound.mp3`,
  speakerIconUrl: `${import.meta.env.BASE_URL}speaker.svg`,
  statusElement: document.getElementById('vr-status'),
  exitButton: document.getElementById('btn-exit-vr'),
});

// Call once per animation frame:
vr.update();
```

## Copy it to another project

1. Build the plain-JavaScript package from this repo:

   ```powershell
   cd my-project
   npm run build:vr
   ```

   That writes ES modules to `my-project/vr-package/`.

2. Copy the whole `my-project/vr-package` folder into the other project as `vr/`.

3. Copy `ambient sound.mp3` and `speaker.svg` next to the other project's HTML if you want the
   ambient audio and speaker icon.

4. Import it from the other project. It expects `three` and `three/addons/` to resolve, either
   through a bundler or an import map:

   ```js
   const { VRExperience } = await import('./vr/index.js');

   const vr = new VRExperience(scene, camera, renderer, {
     overlayRoot: document.getElementById('ui-overlay'),
     ambientSoundUrl: 'ambient sound.mp3',
     speakerIconUrl: 'speaker.svg',
     statusElement: document.getElementById('vr-status'),
     exitButton: document.getElementById('btn-exit-vr'),
   });
   ```

   Then call `vr.update()` on every frame.

## Options

| Option | Default | Purpose |
| --- | --- | --- |
| `overlayRoot` | — | Existing page UI to expose as the WebXR `dom-overlay`. |
| `buttonParent` | `document.body` | Where the `Enter VR` button is appended. |
| `controllers` | created | Reuse controllers the host app already created. |
| `referenceSpaceType` | `local-floor` | Reference space; `local-floor` makes `y = 0` the floor. |
| `sliderPosition` | `(1.5, 1.7, -1.45)` | World position of the 3D volume slider. |
| `initialVolume` | `0.3` | Starting slider/audio volume, 0..1. |
| `volumeSlider` | `true` | Set `false` to skip the 3D slider. |
| `ambientSoundUrl` | — | Looping ambient audio; omit to skip audio. |
| `speakerIconUrl` | — | Speaker icon for the slider; omit to hide it. |
| `statusElement` | — | Receives the support/fallback message. |
| `exitButton` | — | Button that ends the session. |
| `createButton` | `true` | Set `false` if the host app creates its own `VRButton`. |
| `onSessionStart` / `onSessionEnd` | — | App-specific session callbacks. |
| `onVolumeChange` | — | Called with the new 0..1 volume. |

If the host app already enables XR, the module reuses `renderer.xr.enabled = true` and only changes
the reference space type. Pass `controllers` when the app already created controller objects so the
module does not add a second set.
