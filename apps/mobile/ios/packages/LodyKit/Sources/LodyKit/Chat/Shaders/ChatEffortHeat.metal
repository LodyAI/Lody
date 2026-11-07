#include <metal_stdlib>
using namespace metal;

struct HeatVertex { float4 position [[position]]; };

struct HeatUniforms {
  float4 track;
  float4 accent;
  float4 violet;
  float4 dotOff;
  float4 frame;
  float4 clock;
  float4 thumb;
};

constant float trackRadius = 14.0;
constant float thumbRadius = 16.0;

static float sat(float x) { return clamp(x, 0.0, 1.0); }

static float hash(float2 p) {
  float3 q = fract(float3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

static float noise(float2 p) {
  float2 i = floor(p);
  float2 f = fract(p);
  float2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + float2(1, 0)), u.x), mix(hash(i + float2(0, 1)), hash(i + float2(1, 1)), u.x), u.y);
}

static float fbm(float2 p) {
  float sum = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 5; i++) {
    sum += amplitude * noise(p);
    p = p * 2.03 + float2(17.1, 9.2);
    amplitude *= 0.5;
  }
  return sum;
}

static float sdTrack(float2 p, constant HeatUniforms &u) {
  float mid = u.frame.y * 0.5;
  float end = max(trackRadius, u.frame.x - trackRadius);
  return length(float2(p.x - clamp(p.x, trackRadius, end), p.y - mid)) - trackRadius;
}

static float sdFill(float2 p, constant HeatUniforms &u) { return max(sdTrack(p, u), p.x - u.thumb.x); }

static float cover(float d, constant HeatUniforms &u) { return sat(0.5 - d * u.frame.z); }

static float4 over(float4 dst, float3 rgb, float alpha) { return float4(rgb * alpha, alpha) + dst * (1.0 - alpha); }

static float3 heatColor(float t, constant HeatUniforms &u) {
  float3 c = mix(u.accent.rgb, u.violet.rgb, smoothstep(0.15, 0.6, t));
  c = mix(c, float3(0.92, 0.22, 0.32), smoothstep(0.55, 0.85, t));
  c = mix(c, float3(1.0, 0.55, 0.12), smoothstep(0.8, 1.05, t));
  return mix(c, float3(1.0, 0.93, 0.7), smoothstep(1.02, 1.25, t));
}

static float4 heatScene(float2 p, constant HeatUniforms &u) {
  float mid = u.frame.y * 0.5;
  float tx = u.thumb.x;
  float flow = u.clock.x;
  float ultra = u.clock.y;
  float fast = u.clock.z;
  float dTrack = sdTrack(p, u);
  float dFill = sdFill(p, u);
  float4 c = over(float4(0), u.track.rgb, u.track.a * cover(dTrack, u));

  float heat = mix(0.35, 0.62, u.thumb.y) * (1.0 - ultra) + 1.22 * ultra + 0.08 * fast;
  float along = sat(p.x / max(tx, 1.0));
  float t = heat * mix(0.25, 1.0, along * along);
  float lava = fbm(float2(p.x * 0.07 - flow * 0.9, p.y * 0.11 + flow * 0.25));
  float3 fill = heatColor(t + (0.5 - lava) * 0.35 * max(ultra, fast), u);
  fill = mix(fill, fill * 0.25, smoothstep(0.52, 0.66, lava) * ultra * along * 0.8);
  fill += pow(noise(float2((p.x - flow * 150.0) * 0.03, p.y * 0.6)), 6.0) * fast * 0.8 * heatColor(t + 0.3, u);
  c = over(c, fill, cover(dFill, u));

  float steps = max(1.0, u.clock.w);
  float span = max(0.0, u.frame.x - 32.0);
  for (int i = 0; i <= 12; i++) {
    float index = float(i);
    if (index > steps) break;
    float x = 16.0 + index / steps * span;
    float mark = cover(length(p - float2(x, mid)) - 2.5, u);
    if (x <= tx + 0.5) c = over(c, float3(1.0), 0.4 * mark);
    else c = over(c, u.dotOff.rgb, u.dotOff.a * mark);
  }

  float glow = ultra * exp(-max(dFill, 0.0) / 5.0) * (1.0 - cover(dFill, u)) * along;
  c = over(c, float3(1.0, 0.5, 0.15), glow * 0.45);
  float shadow = length(p - float2(tx, mid + 1.0)) - thumbRadius;
  c = over(c, float3(0.0), 0.16 * exp(-pow(max(shadow, 0.0) / 2.0, 2.0)));
  float knob = length(p - float2(tx, mid)) - thumbRadius;
  c = over(c, float3(1.0), cover(knob, u));
  return over(c, float3(1.0, 0.62, 0.25), ultra * 0.7 * exp(-knob * knob / 2.0));
}

vertex HeatVertex heatVertex(uint id [[vertex_id]]) {
  float2 p = float2((id << 1) & 2, id & 2);
  return { float4(p * 2.0 - 1.0, 0, 1) };
}

fragment float4 heatFragment(HeatVertex in [[stage_in]], constant HeatUniforms &u [[buffer(0)]]) {
  float2 p = in.position.xy / u.frame.z;
  float flow = u.clock.x;
  float drag = sat(abs(u.thumb.z) / 700.0);
  float amplitude = 2.2 * u.clock.y + 0.9 * u.clock.z + 1.2 * drag;
  float region = exp(-max(sdFill(p, u), 0.0) / 10.0);
  float2 shimmer = float2(noise(float2(p.x * 0.11, p.y * 0.13 + flow * 2.6)),
                          noise(float2(p.x * 0.11 + 7.0, p.y * 0.13 + flow * 2.6 + 3.0))) - 0.5;
  return heatScene(p + shimmer * amplitude * region * float2(0.6, 1.0), u);
}
