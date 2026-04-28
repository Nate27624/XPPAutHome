import { describe, expect, it } from "vitest";
import { extractStateVariablesFromOde } from "./odeVariables";

describe("extractStateVariablesFromOde", () => {
  it("extracts v and h from the standard T-current model syntax", () => {
    const source = `# Standard T-Current Model
par EL=-78
par gL=0.1, Cm=1, ECa=120, gT=0.5
minf(v) = 1/(1+exp(-(v+65)/7.8))
hinf(v) = 1/(1+exp((v+81)/11))
par tauh=30
dv/dt = (-gL*(v-EL) - gT*minf(v)^3*h*(v-ECa))/Cm
dh/dt = (hinf(v) - h)/tauh
init v=-65, h=0.2
@ total=800
done
`;
    expect(extractStateVariablesFromOde(source)).toEqual(["v", "h"]);
  });
});
