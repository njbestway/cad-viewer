import * as THREE from 'three'

/**
 * Another format of AcTrPatternLine.
 * We need to redefine it in order to send it to gpu.
 */
export interface AcTrPatternLine {
  angle: number // in radians
  base: THREE.Vector2
  offset: THREE.Vector2
  /**
   * Dash and gap list.
   * E.g., [1, -1, 2, -1], defines a line repeats by "- - -- " (a dash, a gap, 2 dashes, a gap...)
   * The array size shouldn't be 0.
   */
  dashLengths: number[]
  /**
   * Total length of a *this* pattern definition.
   * We need to pass it in as a individual variable because it's not convenient to get it in glsl.
   * E.g., for dashLengths: [1, -1, 2, -1], patternLength is 5.
   */
  patternLength: number
}

/**
 *
 * @param patternLines Line patterns. Angles are in radians.
 * @param patternAngle In radians
 * @param cameraZoomUniform Camera zoom uniform
 * @param color Color
 * @param fixedThicknessInWorldCoord Fixed thickness in world coordinates
 * @returns Shader material
 */
export function createHatchPatternShaderMaterial(
  patternLines: AcTrPatternLine[],
  patternAngle: number, // in radians
  cameraZoomUniform: { value: number },
  color: THREE.Color,
  fixedThicknessInWorldCoord = 0,
  side: THREE.Side = THREE.FrontSide
): THREE.Material {
  const maxPatternSegmentCount = Math.max(
    2,
    ...patternLines.map(line => line.dashLengths.length)
  )
  const uniforms = {
    u_cameraZoom: cameraZoomUniform,
    u_patternLines: { value: patternLines },
    u_patternAngle: { value: patternAngle },
    u_color: { value: color }
  }

  // NOTE: aggregate patterns (GRAVEL and friends) render correctly only when
  // `offset` arrives in the line-local frame; the material manager inverse-
  // rotates the world-space stored offset by the line angle before upload.

  const vertexShader = /*glsl*/ `
    varying vec3 v_pos;

    #include <clipping_planes_pars_vertex>
    void main() {
        //vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        v_pos = position;

        #include <begin_vertex>
        #include <project_vertex>
        #include <clipping_planes_vertex>
    }`

  const fragmentShader = /*glsl*/ `
    precision highp float;
    uniform mat4 modelMatrix;
    uniform float u_cameraZoom;
    uniform vec3 u_color;
    varying vec3 v_pos;

    struct PatternLine {
        float angle;
        vec2 base;
        vec2 offset;
        float dashLengths[MAX_PATTERN_SEGMENT_COUNT];
        float patternLength;
    };

    uniform PatternLine u_patternLines[${patternLines.length}];
    uniform float u_patternAngle;

    #include <clipping_planes_pars_fragment>

    // Clamp [0..1] range
    #define saturate(a) clamp(a, 0.0, 1.0)

    const float MAX_THICKNESS = 1000.0; // If line thickness exceeds this, use solid fill instead of pattern
    const float EPSILON = 1e-6;

    vec2 getWorldScale() {
        return vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
    }

    // Rotate a 2D point by rotation angle (in radians)
    vec2 rotate(vec2 samplePos, float angle) {
        float s = sin(angle);
        float c = cos(angle);
        return vec2(c * samplePos.x - s * samplePos.y, c * samplePos.y + s * samplePos.x);
    }

    vec2 translate(vec2 samplePosition, vec2 offset) {
        //move sample point in the opposite direction that we want to move shapes in
        return samplePosition - offset;
    }

    vec2 scale(vec2 samplePosition, float scale) {
        return samplePosition / scale;
    }

    // signed distance from point samplePos to infinite line (a->b)
    float sdfLine(vec2 samplePos, vec2 a, vec2 b) {
        vec2 ap = samplePos - a;
        vec2 ab = b - a;
        return abs((ap.x * ab.y) - (ab.x * ap.y)) / max(length(ab), EPSILON);
    }

    // Along-line dash duty: fraction of one pattern period that is ink.
    // Stipple patterns (GRAVEL) are ~1%, so any area-average fade must scale
    // by this or it over-brightens by two orders of magnitude.
    float dashDuty(PatternLine patternLine) {
        float positive = 0.0;
        #pragma unroll_loop_start
        for (int i = 0; i < patternLine.dashLengths.length(); i++) {
            if (patternLine.dashLengths[i] > 0.0) {
                positive += patternLine.dashLengths[i];
            }
        }
        #pragma unroll_loop_end
        return patternLine.patternLength > 0.0
            ? positive / patternLine.patternLength
            : 1.0;
    }

    // Draw a repeated line pattern in object/world space with smooth anti-aliasing.
    // duty is the along-line ink fraction (1 for solid lines).
    float drawSpaceLine(vec2 samplePos, float distanceBetweenLines, float thick, float duty) {
        float dist = sdfLine(samplePos, vec2(0.0, 0.0), vec2(1.0, 0.0));

        float spacing = max(distanceBetweenLines, EPSILON);
        // compute fractional distance to nearest repeated line center
        float normalizedDist = dist / spacing;
        float lineDistance = abs(fract(normalizedDist + 0.5) - 0.5) * spacing;

        // Row coverage ~1 screen pixel wide while the rows are resolvable, but
        // the fade MUST reach zero by half the row spacing: once a pixel grows
        // past a fraction of the spacing an unbounded 2*thick fade bleeds
        // neighbouring rows into one continuous field (the dense-snowflake
        // symptom at normal zoom, which only clears on zoom-in).
        float edge = min(thick * 1.5, spacing * 0.5);
        float centerCoverage =
            1.0 - smoothstep(thick * 0.5, max(edge, thick * 0.5 + EPSILON), lineDistance);

        // Sub-pixel regime: once a whole screen pixel spans the row spacing the
        // rows are unresolvable; fade to the true 2D mean coverage = along-line
        // dash duty x the area fraction the row lines occupy. While a pixel is
        // still smaller than the spacing keep discrete 1px dots (matching
        // AutoCAD), which the edge cap above keeps from merging.
        float linesPerPixel = thick / spacing;
        float average = duty * min(linesPerPixel, 1.0);
        // Ramp fully into the average by the time one pixel spans the row
        // spacing (linesPerPixel = 1); past that the discrete row coverage is
        // meaningless (its capped edge saturates to 1) and would read as a
        // near-solid fill.
        float denseBlend = saturate((linesPerPixel - 0.75) / 0.25);
        return mix(centerCoverage, average, denseBlend);
    }

    float drawSolidLine(PatternLine patternLine, float thick) {
        vec2 base = patternLine.base;
        vec2 offset = patternLine.offset;
        float distanceBetweenLines = length(offset);

        base = rotate(base, u_patternAngle);
        vec2 samplePos = rotate(v_pos.xy - base, -(patternLine.angle + u_patternAngle));

        return drawSpaceLine(samplePos, distanceBetweenLines, thick, 1.0);
    }

    int getPatternIndex(PatternLine patternLine, float linePosition, out float distance) {
        if (patternLine.dashLengths.length() < 1 || patternLine.patternLength <= 0.0) {
            return -1;
        }

        // Normalize linePosition to [0, patternLength) range
        float patternRepeat = floor(linePosition / patternLine.patternLength);
        linePosition -= patternLine.patternLength * patternRepeat;

        // Use cumulative sum approach for better precision
        float sum = 0.0;
        #pragma unroll_loop_start
        for (int i = 0; i < patternLine.dashLengths.length(); i++) {
            float segmentLength = abs(patternLine.dashLengths[i]);
            if (linePosition <= sum + segmentLength + EPSILON) {
                distance = linePosition - sum;
                // Clamp distance to avoid negative values due to precision
                distance = max(0.0, distance);
                return i;
            }
            sum += segmentLength;
        }
        #pragma unroll_loop_end

        return -1;
    }

    float drawDashedLine(PatternLine patternLine, float thick){
        float opacity = 0.0; // 0.0 = don't draw, 1.0 = draw
        vec2 base = patternLine.base;
        vec2 offset = patternLine.offset;
        float distanceBetweenLines = abs(offset.y);

        base = rotate(base, u_patternAngle);
        vec2 samplePos = rotate(v_pos.xy - base, -(patternLine.angle + u_patternAngle));

        // When the parallel lines fall finer than one pixel the along-line dash
        // phase is unresolvable, and the gap-segment edge fallback below
        // (distance < thick with a large thick) fills every gap so each dash
        // elongates into a long jagged streak (GRAVEL zoomed out). Skip the
        // discrete dash gating and let drawSpaceLine fade the row set toward its
        // mean coverage instead.
        if (thick >= distanceBetweenLines) {
            return drawSpaceLine(
                samplePos,
                distanceBetweenLines,
                thick,
                dashDuty(patternLine)
            );
        }

        float offsetX = 0.0;
        if (abs(offset.y) > EPSILON) {
            offsetX = samplePos.y * offset.x / offset.y;
        }
        float linePosition = samplePos.x - offsetX;
        float distance = 0.0;
        int index = getPatternIndex(patternLine, linePosition, distance);
        if (index < 0 || index >= patternLine.dashLengths.length()) {
            return opacity;
        }

        float size = patternLine.dashLengths[index];
        if (size >= 0.0) {
            // Dash segment: draw the line at its true world-space extent. The
            // along-line gating above already limits painting to [dashStart,
            // dashEnd], so the mark scales with the view and stays world-synced.
            opacity = drawSpaceLine(
                samplePos,
                distanceBetweenLines,
                thick,
                dashDuty(patternLine)
            );
        }
        // Gap segments paint nothing. Previously a gap was painted for up to
        // 'thick' (the world size of one screen pixel) past each dash as a
        // "precision" fallback; that stretched every dash into a zoom-dependent
        // tail (the GRAVEL long-streak symptom) because 'thick' grows as you
        // zoom out. Extreme zoom-out is already backstopped by the MAX_THICKNESS
        // solid fill and the 'thick >= distanceBetweenLines' dense blend above,
        // so the tail is unnecessary and only breaks world-sync.

        return opacity;
    }

    float drawLine(PatternLine patternLine, float thick) {
        float opacity = 0.0;
        if (patternLine.patternLength > 0.0) {
            opacity = drawDashedLine(patternLine, thick);
        } else {
            opacity = drawSolidLine(patternLine, thick);
        }
        return opacity;
    }

    void main() {
        #include <clipping_planes_fragment>

        // Idealy, the thickness of lines in hatch pattern should always be 1 pixel.
        // In Viewer2d, it uses orthographic camera and always in top view,
        // so we adjust thickness by cameraZoom (and also consider worldScale).
        // While 3d view is more complex, it can use perspective camera,
        // its camera position and direction is flexible. We cannot keep line thickness
        // in a fixed pixel any more, and there is no proper way to adjust thickness as camera
        // position changes. So, we need to use a fixed thickness in world coordinates.
#if ${fixedThicknessInWorldCoord} > 0
        float thick = float(${fixedThicknessInWorldCoord});
#else
        vec2 worldScale = getWorldScale();
        float averageScale = (abs(worldScale.x) + abs(worldScale.y))/2.0;
        // possible size of a pixel
        float thick = (0.7 / averageScale) / u_cameraZoom;
#endif

        if (thick > MAX_THICKNESS) {
            gl_FragColor = vec4(u_color, 1.0);
            #include <colorspace_fragment>
            return;
        }

        float total = 0.0;

#if ${patternLines.length} > 1
        #pragma unroll_loop_start
        for (int i = 0; i < u_patternLines.length(); i++) {
            PatternLine pl = u_patternLines[i];
            float opacity = drawLine(pl, thick);
            total += opacity;
        }
        #pragma unroll_loop_end
#else
        float opacity = drawLine(u_patternLines[0], thick);
        total += opacity;
#endif

        total = saturate(total);
        if (total < 0.001) {
            discard;
        }

        gl_FragColor = vec4(u_color * total, 1.0);
        #include <colorspace_fragment>
    }
    `

  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    clipping: true,
    side,
    defines: {
      MAX_PATTERN_SEGMENT_COUNT: maxPatternSegmentCount
    }
  })
}
