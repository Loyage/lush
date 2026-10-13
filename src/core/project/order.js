import ownerMethods from './order-owner.js';
import creationMethods from './order-create.js';
import reservationMethods from './order-reservation.js';
import legacyMergeMethods from './order-legacy-merge.js';
import divergenceMethods from './order-divergence.js';

/** Keep the historical default method object and dynamic Project `this` binding.
 * Check here as well as in project.js: flattening must not hide duplicate methods. */
export function composeOrderMethods(modules) {
  const methods = {};
  for (const [module, entries] of modules) {
    const duplicates = Object.keys(entries).filter(name => Object.prototype.hasOwnProperty.call(methods, name));
    if (duplicates.length) throw new Error(`duplicate order method(s) ${duplicates.join(', ')} from project/${module}.js`);
    Object.assign(methods, entries);
  }
  return methods;
}

export default composeOrderMethods([
  ['order-owner', ownerMethods],
  ['order-create', creationMethods],
  ['order-reservation', reservationMethods],
  ['order-legacy-merge', legacyMergeMethods],
  ['order-divergence', divergenceMethods],
]);
