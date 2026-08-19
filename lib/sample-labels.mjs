const SAMPLE_LABEL_DEFINITIONS = Object.freeze([
  { name: "bark",       color: "#e74c3c" },
  { name: "yap",        color: "#e67e22" },
  { name: "background", color: "#27ae60" },
  { name: "wind",       color: "#2980b9" },
  { name: "homestead",  color: "#8e44ad" },
  { name: "traffic",    color: "#7f8c8d" },
  { name: "wildlife",    color: "#2ea096" },
  { name: "gunshot",    color: "#333333" },
  { name: "wrongdog",   color: "#8a8c00" },
].map(Object.freeze));

export const SAMPLE_LABELS = Object.freeze(
  SAMPLE_LABEL_DEFINITIONS.map(({ name }) => name),
);

export const SAMPLE_LABEL_COLORS = Object.freeze(Object.fromEntries(
  SAMPLE_LABEL_DEFINITIONS.map(({ name, color }) => [name, color]),
));

/** Non-trainable annotation state for detector-created fragments. */
export const REVIEW_FRAGMENT_LABEL = "review";
