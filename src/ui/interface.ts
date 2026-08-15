/**
 * The interface.
 *
 * Built from plain DOM rather than a framework: there are perhaps a dozen
 * elements that ever change, and a render loop competing with the one drawing
 * the world would be a strange thing to add.
 *
 * The whole thing is written to get out of the way. Nothing blinks, nothing
 * counts down, nothing turns red, and the entire HUD fades to nothing when you
 * sit down. The one moment it asks for attention is a discovery card, which
 * appears slowly at the edge of vision and leaves on its own.
 */

import type { Discovery } from '../game/discovery';
import type { DiscoveryTracker } from '../game/discovery';
import type { SavedPhoto } from '../core/storage';
import { PHOTO_FILTERS, type Mode } from '../game/modes';
import { levelForXp } from '../game/discovery';

export interface InterfaceCallbacks {
  onStart: () => void;
  onToggleRest: () => void;
  onTogglePhoto: () => void;
  onToggleJournal: () => void;
  onCapture: () => void;
  onFilterChange: (filterId: string) => void;
  onFocalChange: (mm: number) => void;
  onVolumeChange: (value: number) => void;
  onMuteToggle: () => void;
  onTimeChange: (hour: number) => void;
  onTimeRunningChange: (running: boolean) => void;
  onQualityChange: (tier: string) => void;
  onNewSeed: () => void;
  onPad: (x: number, y: number, active: boolean) => void;
}

export interface HudState {
  clock: string;
  weather: string;
  altitude: number;
  distanceWalked: number;
  worldName: string;
  xp: number;
  discovered: number;
  totalSpecies: number;
  compass: number;
  fps: number;
  showDebug: boolean;
  debug: string;
}

export class Interface {
  readonly root: HTMLElement;

  private hud!: HTMLElement;
  private clockEl!: HTMLElement;
  private placeEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private levelBar!: HTMLElement;
  private levelName!: HTMLElement;
  private compassEl!: HTMLElement;
  private cards!: HTMLElement;
  private breath!: HTMLElement;
  private breathRing!: HTMLElement;
  private breathLabel!: HTMLElement;
  private restHint!: HTMLElement;
  private journal!: HTMLElement;
  private journalBody!: HTMLElement;
  private photoBar!: HTMLElement;
  private settings!: HTMLElement;
  private splash!: HTMLElement;
  private pad!: HTMLElement;
  private touchButtons!: HTMLElement;
  private debugEl!: HTMLElement;
  private vignette!: HTMLElement;

  private padPointer: number | null = null;
  private padCentre = { x: 0, y: 0 };
  private journalOpen = false;
  private settingsOpen = false;
  private currentFilter = 'plain';
  private currentTier = 'auto';

  private volumeSlider!: HTMLInputElement;
  private muteButton!: HTMLElement;
  private timeSlider!: HTMLInputElement;
  private timeLabel!: HTMLElement;

  constructor(private callbacks: InterfaceCallbacks, private isTouch: boolean) {
    this.root = document.getElementById('ui-root')!;
    this.build();
  }

  /**
   * Push saved values back into the controls.
   *
   * Called once after a save is restored. Without it the panel would claim the
   * volume is 80% while the world plays at whatever you actually left it.
   */
  syncSettings(values: { volume: number; muted: boolean; tier: string }) {
    this.volumeSlider.value = String(Math.round(values.volume * 100));
    this.muteButton.classList.toggle('active', values.muted);
    this.muteButton.textContent = values.muted ? 'Muted' : 'Mute';
    this.currentTier = values.tier;
    for (const button of this.settings.querySelectorAll<HTMLElement>('button[data-tier]')) {
      button.classList.toggle('active', button.dataset.tier === values.tier);
    }
  }

  /** Keep the time slider following the clock while time is running. */
  syncClock(hour: number) {
    if (document.activeElement === this.timeSlider) return;
    const minutes = Math.round(hour * 60) % 1440;
    this.timeSlider.value = String(minutes);
    this.timeLabel.textContent =
      `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private build() {
    this.root.innerHTML = '';

    // A vignette over the canvas rather than a post-process. Resting darkens
    // the edges of the frame the way relaxing your eyes narrows attention, and
    // doing it in the compositor costs nothing on a phone.
    this.vignette = el('div', 'vignette');
    this.root.appendChild(this.vignette);

    // --- splash -------------------------------------------------------------
    this.splash = el('div', 'splash');
    this.splash.innerHTML = `
      <div class="splash-inner">
        <h1>Virtual Hiking Trails</h1>
        <p class="lede">
          An endless wilderness with no timers, no threats and nowhere you have
          to be. Walk wherever you like. The only thing to gain is what you
          notice.
        </p>
        <button class="primary" type="button">Begin the walk</button>
        <ul class="controls-list">
          <li><kbd>↑</kbd><kbd>↓</kbd> walk &middot; <kbd>←</kbd><kbd>→</kbd> turn</li>
          <li><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> and the mouse, if you prefer</li>
          <li><kbd>R</kbd> sit and rest &middot; <kbd>P</kbd> photograph &middot; <kbd>J</kbd> journal</li>
          <li><kbd>,</kbd> settings &middot; <kbd>Esc</kbd> back to the walk</li>
        </ul>
        <p class="touch-controls">
          Drag on the right to look around, and use the pad on the left to walk.
        </p>
        <p class="fine">Sound begins when you do. Everything is saved on this device only.</p>
      </div>`;
    this.splash.querySelector('button')!.addEventListener('click', () => {
      this.splash.classList.add('gone');
      this.callbacks.onStart();
    });
    this.root.appendChild(this.splash);

    // --- HUD ----------------------------------------------------------------
    this.hud = el('div', 'hud');

    const topLeft = el('div', 'hud-corner top-left');
    this.clockEl = el('div', 'clock');
    this.placeEl = el('div', 'place');
    topLeft.append(this.clockEl, this.placeEl);

    const topRight = el('div', 'hud-corner top-right');
    this.compassEl = el('div', 'compass');
    topRight.append(this.compassEl);

    const bottomLeft = el('div', 'hud-corner bottom-left');
    this.statsEl = el('div', 'stats');
    const level = el('div', 'level');
    this.levelName = el('div', 'level-name');
    const track = el('div', 'level-track');
    this.levelBar = el('div', 'level-bar');
    track.appendChild(this.levelBar);
    level.append(this.levelName, track);
    bottomLeft.append(this.statsEl, level);

    this.debugEl = el('div', 'debug');
    this.hud.append(topLeft, topRight, bottomLeft, this.debugEl);
    this.root.appendChild(this.hud);

    // --- discovery cards ----------------------------------------------------
    this.cards = el('div', 'cards');
    this.root.appendChild(this.cards);

    // --- rest ---------------------------------------------------------------
    this.breath = el('div', 'breath');
    this.breathRing = el('div', 'breath-ring');
    this.breathLabel = el('div', 'breath-label');
    this.breath.append(this.breathRing, this.breathLabel);
    this.root.appendChild(this.breath);

    this.restHint = el('div', 'rest-hint');
    this.restHint.textContent = this.isTouch ? 'Tap to stand' : 'R to stand';
    this.root.appendChild(this.restHint);

    // --- photo bar ----------------------------------------------------------
    this.photoBar = el('div', 'photo-bar');
    const filters = el('div', 'filters');
    for (const filter of PHOTO_FILTERS) {
      const button = el('button', 'filter');
      button.textContent = filter.name;
      button.dataset.filter = filter.id;
      if (filter.id === this.currentFilter) button.classList.add('active');
      button.addEventListener('click', () => {
        this.currentFilter = filter.id;
        filters.querySelectorAll('.filter').forEach((f) => f.classList.remove('active'));
        button.classList.add('active');
        this.callbacks.onFilterChange(filter.id);
      });
      filters.appendChild(button);
    }

    const focal = el('div', 'focal');
    const focalInput = document.createElement('input');
    focalInput.type = 'range';
    focalInput.min = '24';
    focalInput.max = '135';
    focalInput.value = '50';
    const focalLabel = el('span', 'focal-label');
    focalLabel.textContent = '50mm';
    focalInput.addEventListener('input', () => {
      focalLabel.textContent = `${focalInput.value}mm`;
      this.callbacks.onFocalChange(Number(focalInput.value));
    });
    focal.append(focalInput, focalLabel);

    const shutter = el('button', 'shutter');
    shutter.setAttribute('aria-label', 'Take the photograph');
    shutter.addEventListener('click', () => this.callbacks.onCapture());

    const closePhoto = el('button', 'ghost');
    closePhoto.textContent = 'Done';
    closePhoto.addEventListener('click', () => this.callbacks.onTogglePhoto());

    this.photoBar.append(filters, focal, shutter, closePhoto);
    this.root.appendChild(this.photoBar);

    // --- journal ------------------------------------------------------------
    this.journal = el('div', 'panel journal');
    const journalHead = el('div', 'panel-head');
    const journalTitle = el('h2', '');
    journalTitle.textContent = 'Field Journal';
    const journalClose = el('button', 'ghost');
    journalClose.textContent = 'Close';
    journalClose.addEventListener('click', () => this.callbacks.onToggleJournal());
    journalHead.append(journalTitle, journalClose);
    this.journalBody = el('div', 'panel-body');
    this.journal.append(journalHead, this.journalBody);
    this.root.appendChild(this.journal);

    // --- settings -----------------------------------------------------------
    this.settings = el('div', 'panel settings');
    this.root.appendChild(this.settings);
    this.buildSettings();

    // --- touch --------------------------------------------------------------
    this.pad = el('div', 'pad');
    this.pad.innerHTML = `
      <div class="pad-ring"></div>
      <div class="pad-stick"></div>
      <div class="pad-arrow up">▲</div>
      <div class="pad-arrow down">▼</div>
      <div class="pad-arrow left">◀</div>
      <div class="pad-arrow right">▶</div>`;
    this.root.appendChild(this.pad);
    this.attachPad();

    this.touchButtons = el('div', 'touch-buttons');
    for (const [label, handler, aria, action] of [
      ['\u25ce', () => this.callbacks.onToggleRest(), 'Sit and rest', 'rest'],
      ['\u25c7', () => this.callbacks.onTogglePhoto(), 'Photograph', 'photo'],
      ['\u2767', () => this.callbacks.onToggleJournal(), 'Field journal', 'journal'],
      ['\u2699', () => this.toggleSettings(), 'Settings', 'settings'],
    ] as Array<[string, () => void, string, string]>) {
      const button = el('button', 'round');
      button.textContent = label;
      button.setAttribute('aria-label', aria);
      // The settings gear is the one button that stays on desktop: everything
      // else there has a key, but nobody guesses at a shortcut for a volume
      // slider they haven't been told exists.
      button.dataset.action = action;
      button.addEventListener('click', handler);
      this.touchButtons.appendChild(button);
    }
    this.root.appendChild(this.touchButtons);

    if (this.isTouch) this.root.classList.add('touch');
  }

  private buildSettings() {
    this.settings.innerHTML = '';
    const head = el('div', 'panel-head');
    const title = el('h2', '');
    title.textContent = 'Settings';
    const close = el('button', 'ghost');
    close.textContent = 'Close';
    close.addEventListener('click', () => this.toggleSettings());
    head.append(title, close);

    const body = el('div', 'panel-body');

    body.appendChild(this.row('Sound', (() => {
      const wrap = el('div', 'inline');
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '100';
      slider.value = '80';
      slider.addEventListener('input', () => this.callbacks.onVolumeChange(Number(slider.value) / 100));
      const mute = el('button', 'ghost small');
      mute.textContent = 'Mute';
      mute.addEventListener('click', () => {
        const muted = mute.classList.toggle('active');
        mute.textContent = muted ? 'Muted' : 'Mute';
        this.callbacks.onMuteToggle();
      });
      this.volumeSlider = slider;
      this.muteButton = mute;
      wrap.append(slider, mute);
      return wrap;
    })()));

    body.appendChild(this.row('Time of day', (() => {
      const wrap = el('div', 'inline');
      const slider = document.createElement('input');
      slider.type = 'range';
      slider.min = '0';
      slider.max = '1440';
      slider.value = '570';
      const label = el('span', 'value');
      label.textContent = '09:30';
      slider.addEventListener('input', () => {
        const minutes = Number(slider.value);
        const hour = minutes / 60;
        label.textContent = `${String(Math.floor(hour)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
        this.callbacks.onTimeChange(hour);
      });
      const running = el('button', 'ghost small active');
      running.textContent = 'Time moves';
      running.addEventListener('click', () => {
        const on = running.classList.toggle('active');
        running.textContent = on ? 'Time moves' : 'Time held';
        this.callbacks.onTimeRunningChange(on);
      });
      this.timeSlider = slider;
      this.timeLabel = label;
      wrap.append(slider, label, running);
      return wrap;
    })()));

    body.appendChild(this.row('Detail', (() => {
      const wrap = el('div', 'inline');
      for (const tier of ['low', 'medium', 'high', 'ultra', 'auto']) {
        const button = el('button', 'ghost small');
        button.textContent = tier[0].toUpperCase() + tier.slice(1);
        button.dataset.tier = tier;
        if (tier === this.currentTier) button.classList.add('active');
        button.addEventListener('click', () => {
          wrap.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
          button.classList.add('active');
          this.callbacks.onQualityChange(tier);
        });
        wrap.appendChild(button);
      }
      return wrap;
    })()));

    body.appendChild(this.row('This world', (() => {
      const wrap = el('div', 'inline');
      const newSeed = el('button', 'ghost small');
      newSeed.textContent = 'Walk somewhere else';
      newSeed.addEventListener('click', () => this.callbacks.onNewSeed());
      wrap.append(newSeed);
      return wrap;
    })()));

    const credits = el('p', 'fine');
    credits.innerHTML =
      'Plants, rocks and ground are CC0 photoscans from ' +
      '<a href="https://polyhaven.com" target="_blank" rel="noreferrer noopener">Poly Haven</a>. ' +
      'Birdsong is CC BY-SA from Wikimedia Commons — see CREDITS.md for each recordist. ' +
      'Wind, water and footsteps are synthesised as you walk.';
    body.appendChild(credits);

    this.settings.append(head, body);
  }

  private row(label: string, control: HTMLElement): HTMLElement {
    const row = el('div', 'row');
    const name = el('div', 'row-label');
    name.textContent = label;
    row.append(name, control);
    return row;
  }

  // -------------------------------------------------------------------------
  // Touch pad
  // -------------------------------------------------------------------------

  private attachPad() {
    const stick = this.pad.querySelector('.pad-stick') as HTMLElement;

    const begin = (e: PointerEvent) => {
      this.padPointer = e.pointerId;
      const rect = this.pad.getBoundingClientRect();
      this.padCentre.x = rect.left + rect.width / 2;
      this.padCentre.y = rect.top + rect.height / 2;
      this.pad.setPointerCapture(e.pointerId);
      move(e);
    };

    const move = (e: PointerEvent) => {
      if (this.padPointer !== e.pointerId) return;
      const radius = this.pad.getBoundingClientRect().width / 2;
      let dx = (e.clientX - this.padCentre.x) / radius;
      let dy = (e.clientY - this.padCentre.y) / radius;
      const magnitude = Math.hypot(dx, dy);
      if (magnitude > 1) {
        dx /= magnitude;
        dy /= magnitude;
      }
      stick.style.transform = `translate(${dx * 34}px, ${dy * 34}px)`;
      // Screen-down is walking backward; screen-right is turning right.
      this.callbacks.onPad(dx, -dy, true);
    };

    const end = (e: PointerEvent) => {
      if (this.padPointer !== e.pointerId) return;
      this.padPointer = null;
      stick.style.transform = '';
      this.callbacks.onPad(0, 0, false);
    };

    this.pad.addEventListener('pointerdown', begin);
    this.pad.addEventListener('pointermove', move);
    this.pad.addEventListener('pointerup', end);
    this.pad.addEventListener('pointercancel', end);
  }

  // -------------------------------------------------------------------------
  // Updating
  // -------------------------------------------------------------------------

  update(state: HudState, mode: Mode, uiFade: number, breath: number, breathPhase: string, vignette: number) {
    this.vignette.style.opacity = vignette.toFixed(3);

    this.clockEl.textContent = state.clock;
    this.placeEl.textContent = `${state.worldName} · ${state.weather}`;
    this.statsEl.textContent =
      `${Math.round(state.altitude)} m · ${formatDistance(state.distanceWalked)} walked · ` +
      `${state.discovered} of ${state.totalSpecies} species`;

    const level = levelForXp(state.xp);
    this.levelName.textContent = `${level.name} · ${state.xp} XP`;
    this.levelBar.style.width = `${(level.progress * 100).toFixed(1)}%`;

    // A compass bearing rather than a rotating needle: easier to read at a
    // glance and it never spins distractingly.
    this.compassEl.textContent = bearingName(state.compass);

    this.hud.style.opacity = String(1 - uiFade);
    this.hud.style.pointerEvents = uiFade > 0.5 ? 'none' : '';

    this.breath.style.opacity = mode === 'resting' ? String(uiFade) : '0';
    const scale = 0.55 + breath * 0.45;
    this.breathRing.style.transform = `scale(${scale.toFixed(3)})`;
    this.breathLabel.textContent = breathPhase;
    this.restHint.style.opacity = mode === 'resting' ? String(uiFade * 0.5) : '0';

    this.photoBar.classList.toggle('open', mode === 'photo');
    this.touchButtons.style.opacity = String(1 - uiFade);
    this.pad.style.opacity = mode === 'walking' ? '1' : '0';
    this.pad.style.pointerEvents = mode === 'walking' ? '' : 'none';

    this.debugEl.style.display = state.showDebug ? 'block' : 'none';
    if (state.showDebug) this.debugEl.textContent = state.debug;
  }

  /**
   * A discovery card.
   *
   * Slides in at the lower right, sits for long enough to read properly, and
   * leaves. It never demands a click and never blocks anything.
   */
  showDiscovery(discovery: Discovery) {
    const card = el('div', 'card');
    card.innerHTML = `
      <div class="card-kind">${discovery.kind === 'landmark' ? 'Landmark' : 'First sighting'}</div>
      <div class="card-name"></div>
      <div class="card-sub"></div>
      <div class="card-note"></div>
      <div class="card-xp">+${discovery.xp}</div>`;
    (card.querySelector('.card-name') as HTMLElement).textContent = discovery.name;
    (card.querySelector('.card-sub') as HTMLElement).textContent = discovery.subtitle;
    (card.querySelector('.card-note') as HTMLElement).textContent = discovery.note;

    this.cards.appendChild(card);
    requestAnimationFrame(() => card.classList.add('in'));

    const linger = discovery.note.length > 90 ? 9000 : 6500;
    setTimeout(() => {
      card.classList.remove('in');
      setTimeout(() => card.remove(), 900);
    }, linger);

    // Never let a backlog build up.
    while (this.cards.children.length > 3) this.cards.firstElementChild!.remove();
  }

  toggleJournal(tracker: DiscoveryTracker, photos: SavedPhoto[]) {
    this.journalOpen = !this.journalOpen;
    this.journal.classList.toggle('open', this.journalOpen);
    if (this.journalOpen) this.renderJournal(tracker, photos);
  }

  get isJournalOpen(): boolean {
    return this.journalOpen;
  }

  private toggleSettings() {
    this.settingsOpen = !this.settingsOpen;
    this.settings.classList.toggle('open', this.settingsOpen);
  }

  openSettings() {
    if (!this.settingsOpen) this.toggleSettings();
  }

  closeAll() {
    this.journalOpen = false;
    this.settingsOpen = false;
    this.journal.classList.remove('open');
    this.settings.classList.remove('open');
  }

  get anyPanelOpen(): boolean {
    return this.journalOpen || this.settingsOpen;
  }

  private renderJournal(tracker: DiscoveryTracker, photos: SavedPhoto[]) {
    const body = this.journalBody;
    body.innerHTML = '';

    const level = levelForXp(tracker.progress.xp);
    const entries = tracker.progress.discovered.length;
    const summary = el('div', 'journal-summary');
    summary.innerHTML = `
      <div class="big"></div>
      <div class="fine"></div>`;
    (summary.querySelector('.big') as HTMLElement).textContent = level.name;
    (summary.querySelector('.fine') as HTMLElement).textContent =
      `${tracker.progress.xp} XP · ${entries} ${entries === 1 ? 'entry' : 'entries'} · ` +
      `${formatDistance(tracker.progress.distanceWalked)} walked`;
    body.appendChild(summary);

    // --- landmarks ----------------------------------------------------------
    const landmarks = tracker.progress.discovered.filter((d) => d.kind === 'landmark');
    if (landmarks.length) {
      body.appendChild(heading('Places'));
      const list = el('div', 'entries');
      for (const found of landmarks.slice().reverse()) {
        list.appendChild(entry(found.name, found.subtitle, found.note, true));
      }
      body.appendChild(list);
    }

    // --- species ------------------------------------------------------------
    //
    // Only what has been found gets an entry. Thirty-odd identical "not yet
    // found" rows would say nothing except that the list is long; a single
    // count says the same thing and leaves the page to the things you have
    // actually seen.
    body.appendChild(heading('Living things'));
    const index = tracker.speciesIndex();
    const found = index.filter((row) => row.found);
    const list = el('div', 'entries');

    if (found.length) {
      for (const row of found) {
        list.appendChild(entry(row.species.name, row.species.latin, row.species.note, true));
      }
    } else {
      const nothing = el('div', 'entry unfound');
      const line = el('div', 'entry-sub');
      line.textContent = 'Nothing noticed yet. Look at things as you pass them.';
      nothing.appendChild(line);
      list.appendChild(nothing);
    }
    body.appendChild(list);

    const remaining = index.length - found.length;
    if (remaining > 0) {
      const note = el('p', 'fine remaining');
      note.textContent = `${remaining} more still to find.`;
      body.appendChild(note);
    }

    // --- photographs --------------------------------------------------------
    if (photos.length) {
      body.appendChild(heading('Photographs'));
      const gallery = el('div', 'gallery');
      for (const photo of photos.slice().reverse()) {
        const figure = el('figure', '');
        const img = document.createElement('img');
        img.src = photo.thumbnail;
        img.alt = photo.caption;
        img.loading = 'lazy';
        const caption = el('figcaption', '');
        caption.textContent = photo.caption;
        figure.append(img, caption);
        gallery.appendChild(figure);
      }
      body.appendChild(gallery);
    }
  }

  /** A brief white flash when the shutter fires. */
  flash() {
    const flash = el('div', 'flash');
    this.root.appendChild(flash);
    requestAnimationFrame(() => flash.classList.add('on'));
    setTimeout(() => flash.remove(), 420);
  }

  toast(message: string) {
    const toast = el('div', 'toast');
    toast.textContent = message;
    this.root.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('in'));
    setTimeout(() => {
      toast.classList.remove('in');
      setTimeout(() => toast.remove(), 600);
    }, 2600);
  }
}

// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function heading(text: string): HTMLElement {
  const h = el('h3', 'journal-heading');
  h.textContent = text;
  return h;
}

function entry(name: string, subtitle: string, note: string, found: boolean): HTMLElement {
  const item = el('div', found ? 'entry' : 'entry unfound');
  const title = el('div', 'entry-name');
  title.textContent = name;
  const sub = el('div', 'entry-sub');
  sub.textContent = subtitle;
  item.append(title, sub);
  if (note) {
    const body = el('div', 'entry-note');
    body.textContent = note;
    item.appendChild(body);
  }
  return item;
}

function formatDistance(metres: number): string {
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(2)} km`;
}

/** Bearing to a compass point, which is how anyone actually navigates. */
function bearingName(yaw: number): string {
  const degrees = ((-yaw * 180) / Math.PI + 360) % 360;
  const points = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const index = Math.round(degrees / 22.5) % 16;
  return `${points[index]} · ${Math.round(degrees)}°`;
}
