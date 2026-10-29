"use strict";

// Fork IPC is cooperative; Windows child.kill('SIGTERM') cannot run owner cleanup.
const STOP_MESSAGE_TYPE = "canary-readonly-stop/v1";
const READY_MESSAGE_TYPE = "canary-readonly-ready/v1";

function installCanaryReadOnlyStop(stop, proc = process, supervised = false) {
  if (!proc.channel) {
    if (supervised) stop();
    return () => {};
  }
  const onMessage = (message) => {
    if (message && typeof message === "object" && !Array.isArray(message) &&
        Object.keys(message).length === 1 && message.type === STOP_MESSAGE_TYPE) stop();
  };
  const onDisconnect = () => stop();
  proc.on("message", onMessage);
  proc.on("disconnect", onDisconnect);
  if (!proc.connected) stop();
  else if (supervised) {
    try {
      proc.send({ type: READY_MESSAGE_TYPE }, (error) => { if (error) stop(); });
    } catch (_) { stop(); }
  }
  return () => {
    proc.off("message", onMessage);
    proc.off("disconnect", onDisconnect);
  };
}

module.exports = { installCanaryReadOnlyStop, STOP_MESSAGE_TYPE, READY_MESSAGE_TYPE };
