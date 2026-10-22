/** Device and browser share the exact speed choices. Larger multipliers play faster. */
export const MOTION_SPEEDS = Object.freeze(['0.5', '0.75', '1', '1.5', '2']);
export const MOTION_SPEED_DEFAULT = '1';
export const MOTION_SPEED_MODES = MOTION_SPEEDS.map(id => ({ id, label: `${id}×${id === '1' ? '（默认）' : ''}` }));
export const MOTION_EASING = 'cubic-bezier(.2, 0, .2, 1)';
