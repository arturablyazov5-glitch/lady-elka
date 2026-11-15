// QA only: deny every outgoing server fetch before importing the production server.
globalThis.fetch=async()=>{throw new Error('Offline blog QA: outgoing network denied');};
