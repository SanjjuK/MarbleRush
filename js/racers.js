// racers.js: Who is in the race.
//
// Deliberately a module of its own, with NO imports.
//
// `MARBLE_DATA` used to live in marbles.js, which imports three and cannon-es
// to build meshes and bodies. betting.js needs only the names and colours, so
// importing it from there dragged the whole 3D stack into anything that
// touched betting, including the 2D build and the Node harness.
//
// The order of this array is the racer index used everywhere else: betting
// pools, all-time form, finishing order, saved history in localStorage.
// APPEND to it, never reorder, or saved form silently attaches to the wrong
// racer.

export const MARBLE_DATA = [
  { name: 'Blaze',   ticker: 'BLZ', hex: '#ff5a3c', accent: '#ffd9a0', pattern: 'flame',   trait: 'Fast starter, poor in tight corners' },
  { name: 'Frost',   ticker: 'FRS', hex: '#35b6f2', accent: '#eaf8ff', pattern: 'orbit',   trait: 'Consistent line, rarely spins out' },
  { name: 'Venom',   ticker: 'VNM', hex: '#49d17a', accent: '#0f2e1c', pattern: 'venom',   trait: 'Thrives in the peg fields' },
  { name: 'Royal',   ticker: 'ROY', hex: '#9a6bff', accent: '#ffd9f5', pattern: 'crown',   trait: 'Heavy, carries speed on the banking' },
  { name: 'Bullion', ticker: 'BUL', hex: '#f0b429', accent: '#6b4a05', pattern: 'bullion', trait: 'Late charger on the runway' },
];

/** A darker shade of each racer's colour, for 2D shading and trails. */
export const MARBLE_DARK = ['#8e2a14', '#12527a', '#166b38', '#4a2b9e', '#7a5806'];
