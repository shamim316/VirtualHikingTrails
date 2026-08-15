/**
 * Input.
 *
 * Three ways to walk, all feeding the same small intent object:
 *
 *   - Arrow keys, as asked for: up/down walk, left/right turn. This is the
 *     "I just want to look at trees" control scheme and needs no mouse at all.
 *   - WASD with mouse look, for people who expect a first-person game to
 *     behave like one.
 *   - Touch: a directional pad on the left, drag anywhere else to look.
 *
 * They are live simultaneously. Nothing here is modal, and nothing has to be
 * configured before you can start walking.
 */

export interface InputState {
  /** -1 back .. +1 forward. */
  forward: number;
  /** -1 left .. +1 right, as strafing. */
  strafe: number;
  /** -1 left .. +1 right, as turning. Arrow keys and the touch pad use this. */
  turn: number;
  /** Look delta this frame, in radians. */
  lookX: number;
  lookY: number;
  /** Held to walk a little faster. */
  brisk: boolean;
  /** True while any movement input is active. */
  moving: boolean;
}

type Action = 'rest' | 'photo' | 'journal' | 'map' | 'settings' | 'escape' | 'help' | 'capture';

const KEY_ACTIONS: Record<string, Action> = {
  KeyR: 'rest',
  KeyP: 'photo',
  KeyJ: 'journal',
  KeyM: 'map',
  Comma: 'settings',
  Escape: 'escape',
  Slash: 'help',
  Space: 'capture',
};

export class Input {
  readonly state: InputState = {
    forward: 0, strafe: 0, turn: 0, lookX: 0, lookY: 0, brisk: false, moving: false,
  };

  /** Mouse look sensitivity, radians per pixel. */
  lookSensitivity = 0.0022;
  touchLookSensitivity = 0.0042;
  /** Set false while a panel is open so walking doesn't continue underneath it. */
  enabled = true;

  private keys = new Set<string>();
  private listeners = new Map<Action, Set<() => void>>();
  private pointerLocked = false;
  private touchLookId: number | null = null;
  private touchLookLast = { x: 0, y: 0 };
  private padVector = { x: 0, y: 0 };
  private padActive = false;
  private element: HTMLElement;
  private detachFns: Array<() => void> = [];

  constructor(element: HTMLElement) {
    this.element = element;
    this.attach();
  }

  on(action: Action, fn: () => void) {
    let set = this.listeners.get(action);
    if (!set) this.listeners.set(action, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  private emit(action: Action) {
    for (const fn of this.listeners.get(action) ?? []) fn();
  }

  private attach() {
    const onKeyDown = (e: KeyboardEvent) => {
      // Never swallow typing in a text field.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      this.keys.add(e.code);
      const action = KEY_ACTIONS[e.code];
      if (action) {
        // Space is only a shutter release in photo mode; listeners decide.
        e.preventDefault();
        this.emit(action);
      }
      // Stop the page scrolling out from under the game.
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    };
    const onKeyUp = (e: KeyboardEvent) => this.keys.delete(e.code);
    const onBlur = () => this.keys.clear();

    window.addEventListener('keydown', onKeyDown, { passive: false });
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    this.detachFns.push(() => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    });

    // --- mouse look ---------------------------------------------------------
    const onMouseMove = (e: MouseEvent) => {
      if (!this.pointerLocked || !this.enabled) return;
      this.state.lookX -= e.movementX * this.lookSensitivity;
      this.state.lookY -= e.movementY * this.lookSensitivity;
    };
    const onPointerLockChange = () => {
      this.pointerLocked = document.pointerLockElement === this.element;
    };
    const onClick = () => {
      if (!this.enabled || this.pointerLocked) return;
      // Pointer lock can reject (e.g. straight after exiting); that's fine,
      // arrow keys still work.
      this.element.requestPointerLock?.();
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onPointerLockChange);
    this.element.addEventListener('click', onClick);
    this.detachFns.push(() => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('pointerlockchange', onPointerLockChange);
      this.element.removeEventListener('click', onClick);
    });

    // --- touch look ---------------------------------------------------------
    const onTouchStart = (e: TouchEvent) => {
      if (!this.enabled) return;
      for (const touch of Array.from(e.changedTouches)) {
        // The left third is reserved for the walking pad, which handles its
        // own touches.
        if (touch.clientX < window.innerWidth * 0.36 && touch.clientY > window.innerHeight * 0.45) continue;
        if (this.touchLookId === null) {
          this.touchLookId = touch.identifier;
          this.touchLookLast.x = touch.clientX;
          this.touchLookLast.y = touch.clientY;
        }
      }
    };
    const onTouchMove = (e: TouchEvent) => {
      if (!this.enabled) return;
      for (const touch of Array.from(e.changedTouches)) {
        if (touch.identifier !== this.touchLookId) continue;
        this.state.lookX -= (touch.clientX - this.touchLookLast.x) * this.touchLookSensitivity;
        this.state.lookY -= (touch.clientY - this.touchLookLast.y) * this.touchLookSensitivity;
        this.touchLookLast.x = touch.clientX;
        this.touchLookLast.y = touch.clientY;
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      for (const touch of Array.from(e.changedTouches)) {
        if (touch.identifier === this.touchLookId) this.touchLookId = null;
      }
    };

    this.element.addEventListener('touchstart', onTouchStart, { passive: true });
    this.element.addEventListener('touchmove', onTouchMove, { passive: true });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);
    this.detachFns.push(() => {
      this.element.removeEventListener('touchstart', onTouchStart);
      this.element.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    });
  }

  /** Called by the on-screen pad. `x` and `y` are each -1..1. */
  setPad(x: number, y: number, active: boolean) {
    this.padVector.x = x;
    this.padVector.y = y;
    this.padActive = active;
  }

  releasePointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  get isPointerLocked() {
    return this.pointerLocked;
  }

  /** Fold the raw inputs into this frame's intent and clear the look deltas. */
  sample(): InputState {
    const s = this.state;
    if (!this.enabled) {
      s.forward = 0; s.strafe = 0; s.turn = 0; s.lookX = 0; s.lookY = 0;
      s.brisk = false; s.moving = false;
      return s;
    }

    const k = this.keys;
    let forward = 0;
    let strafe = 0;
    let turn = 0;

    if (k.has('ArrowUp') || k.has('KeyW')) forward += 1;
    if (k.has('ArrowDown') || k.has('KeyS')) forward -= 1;
    if (k.has('KeyA')) strafe -= 1;
    if (k.has('KeyD')) strafe += 1;
    // Arrow left/right turn rather than strafe: the whole point of the arrow
    // scheme is that you can steer without a mouse.
    if (k.has('ArrowLeft')) turn -= 1;
    if (k.has('ArrowRight')) turn += 1;

    if (this.padActive) {
      forward += this.padVector.y;
      turn += this.padVector.x;
    }

    s.forward = Math.max(-1, Math.min(1, forward));
    s.strafe = Math.max(-1, Math.min(1, strafe));
    s.turn = Math.max(-1, Math.min(1, turn));
    s.brisk = k.has('ShiftLeft') || k.has('ShiftRight');
    s.moving = Math.abs(s.forward) > 0.05 || Math.abs(s.strafe) > 0.05;
    return s;
  }

  /** Consume this frame's look delta. */
  takeLook(): { x: number; y: number } {
    const out = { x: this.state.lookX, y: this.state.lookY };
    this.state.lookX = 0;
    this.state.lookY = 0;
    return out;
  }

  dispose() {
    for (const fn of this.detachFns) fn();
    this.detachFns.length = 0;
    this.keys.clear();
    this.listeners.clear();
  }
}
