export const flowOptions = [
  {id: 'current', label: 'Original / reference', strength: 1, length: 81, gap: 99},
  {id: 'a', label: 'A / Soft', strength: .3, length: 16.2, gap: 29.7},
  {id: 'b', label: 'B / Fine', strength: .2, length: 16.2, gap: 19.8},
  {id: 'c', label: 'C / Subtle', strength: .1, length: 16.2, gap: 9.9},
];

export function flowFragment(option) {
  let phase = 'let phase = fract(in.uv.x - clock.x * 0.85);';
  let signal = 'phase', strength = '';
  if (option) {
    const {length, gap, strength: light} = option;
    if (![length, gap, light].every(Number.isFinite) || length <= 0 || gap <= 0 || light <= 0 || light > 1) {
      throw new Error('Invalid relation-flow comparison parameters.');
    }
    const period = length + gap;
    phase = `let phase = fract((in.uv.x - clock.x * 0.85) * ${180 / period});
  let shape = 1.0 - (1.0 - phase) * ${.45 * period / length};`;
    signal = 'shape';
    strength = ` * ${light}`;
  }
  return `@fragment fn flow(in: Vertex) -> @location(0) vec4f {
  ${phase}
  let pulse = smoothstep(0.55, 0.88, ${signal}) * (1.0 - smoothstep(0.9, 1.0, ${signal}))${strength};
  return vec4f(mix(in.color.rgb, vec3f(0.8, 0.96, 1.0), pulse),
    in.color.a * (0.55 + 0.45 * pulse));
}`;
}
