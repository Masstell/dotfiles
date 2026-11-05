# Emitter

A small event emitter (CommonJS: `module.exports = { Emitter }`). Where this spec describes behaviour,
it is the behaviour of Node's `EventEmitter`; implement it yourself without `events`/`node:events`.
There are no `newListener`/`removeListener` meta-events and no max-listener warnings.

- `on(event, fn)` (alias `addListener`): adds fn at the end of event's list. The same fn may be added
  more than once. Returns the emitter. A non-function fn throws `TypeError`.
- `prependListener(event, fn)`: adds fn at the front.
- `once(event, fn)` / `prependOnceListener(event, fn)`: like `on` / `prependListener`, but the
  registration is removed just before fn is called the first time, and fn is called at most once, even if
  it is also part of an emit that started earlier (see emit).
- `off(event, fn)` (alias `removeListener`): removes ONE registration of fn for event: the one that comes
  last in event's list (call order), counting `once` registrations of fn too. Nothing happens if there is
  none. Returns the emitter.
- `removeAllListeners(event)`: removes all of event's listeners; with no argument, every event's.
  Returns the emitter.
- `emit(event, ...args)`: calls the listeners event has at the moment emit starts, in order, each with
  `this` set to the emitter and the given args. Listeners added or removed while it runs (by a listener)
  don't change which listeners this emit calls (except that a once-listener that has already fired is not
  called again). If a listener throws, emit stops and the error propagates. Returns `true` if event had
  listeners, else `false`.
  - `emit("error", err)` with no `"error"` listeners throws: `err` itself if it is an `Error`, otherwise
    some `Error`.
- `listeners(event)`: a new array of event's listener functions in call order (for once-listeners, the
  function that was passed to `once`).
- `listenerCount(event)`: how many listeners event has.
- `eventNames()`: the events that currently have listeners, in the order each one got its first listener
  (an event whose listeners were all removed and then re-added counts as new and goes last).
