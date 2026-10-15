// Shared between the Overground (writer) and the background crowd (reader): people leave the station in a burst
// when a train has stopped, not in a steady trickle. `active` is false when the Overground module isn't running,
// and then nobody waits for a train.
export const stationPulse = {
  active: false,
  /** Increments each time a train's doors open at Shoreditch High Street. */
  arrivals: 0,
  /** Increments each time a train pulls out. */
  departures: 0,
};
