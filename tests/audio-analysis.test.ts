import {describe,it,expect} from 'vitest';
import {measurePCM,compareAudio} from '../ui/audio-analysis';
const rate=48000,tone=(hz:number,level=1)=>Float32Array.from({length:rate},(_,i)=>Math.sin(2*Math.PI*hz*i/rate)*level);
describe('PCM measurements from real generated signals',()=>{
 it('finds a 1 kHz sine and its analytical RMS and band energy',async()=>{const m=await measurePCM([tone(1000)],rate);expect(m.rmsDbFS).toBeCloseTo(-3.0103,3);expect(m.crestDb).toBeCloseTo(3.0103,3);expect(m.dominantFrequencyHz).toBeCloseTo(996.09375,3);expect(Math.abs(m.spectralCentroidHz!-1000)).toBeLessThan(1);expect(m.bands[2].energyPercent).toBeGreaterThan(99.9);});
 it('includes the right channel and does not cancel an anti-phase spectrum',async()=>{const l=tone(1000,.5),r=Float32Array.from(l,x=>-x),m=await measurePCM([l,r],rate);expect(m.stereoCorrelation).toBeCloseTo(-1,6);expect(m.rmsDbFS).toBeCloseTo(-9.0309,3);expect(m.bands[2].energyPercent).toBeGreaterThan(99.9);const rightOnly=await measurePCM([new Float32Array(rate),tone(1000)],rate);expect(rightOnly.rmsDbFS).toBeCloseTo(-6.0206,3);expect(rightOnly.stereoCorrelation).toBeNull();});
 it('reports silence as absent signal, with no invented spectrum',async()=>{const m=await measurePCM([new Float32Array(rate)],rate);expect(m.rmsDbFS).toBeNull();expect(m.spectralCentroidHz).toBeNull();expect(m.bands.every(b=>b.energyPercent===null)).toBe(true);expect(JSON.stringify(m)).not.toContain('NaN');});
 it('compares levels without interpreting gain as a change in spectral balance',async()=>{const [a,b]=await Promise.all([measurePCM([tone(1000,.5)],rate),measurePCM([tone(1000)],rate)]);const c=compareAudio(a,b);expect(c.rmsDifferenceDb).toBeCloseTo(-6.0206,3);expect(c.bandDifferencePercentagePoints?.[2].difference).toBeCloseTo(0,6);});
 it('detects lower-band energy and aborts CPU work on cancellation',async()=>{const m=await measurePCM([tone(93.75)],rate);expect(m.bands[1].energyPercent).toBeGreaterThan(99);const controller=new AbortController();controller.abort();await expect(measurePCM([tone(1000)],rate,controller.signal)).rejects.toThrow();});
 it('rejects non-finite PCM and empty inputs',async()=>{await expect(measurePCM([new Float32Array([NaN])],rate)).rejects.toThrow();await expect(measurePCM([],rate)).rejects.toThrow();});
});
it('keeps valid band ranges and reports the measured ceiling at low sample rates',async()=>{
 const m=await measurePCM([new Float32Array(8000)],8000);expect(m.bands.every(b=>b.toHz>b.fromHz)).toBe(true);expect(m.bands[3]).toMatchObject({fromHz:2000,toHz:6000,analyzedToHz:4000});expect(m.bands[4]).toMatchObject({fromHz:6000,toHz:20000,analyzedToHz:null,energyPercent:null});
 const high=await measurePCM([new Float32Array(48000)],48000);expect(compareAudio(m,high).bandDifferencePercentagePoints).toBeNull();
});
