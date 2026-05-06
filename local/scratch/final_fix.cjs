const fs = require('fs');
let content = fs.readFileSync('client/src/pages/lane-work-queue.tsx', 'utf8');

// The LaneRow closing parts were missing
const laneRowStart = content.indexOf('function LaneRow({');
const laneRowEndMarker = 'isHighFreq ? "border-amber-500/20" : "border-border"';
const laneRowEndIndex = content.indexOf(laneRowEndMarker);

// This is getting too complex with string manipulation on a potentially corrupted file.
// I will rewrite the components properly.
