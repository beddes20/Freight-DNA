declare module "leaflet.heat" {
  import * as L from "leaflet";
  namespace HeatLayer {
    interface Options {
      minOpacity?: number;
      maxZoom?: number;
      max?: number;
      radius?: number;
      blur?: number;
      gradient?: Record<number, string>;
    }
  }
  function heatLayer(
    latlngs: Array<[number, number, number?]>,
    options?: HeatLayer.Options
  ): L.Layer;
}
declare namespace L {
  function heatLayer(
    latlngs: Array<[number, number, number?]>,
    options?: {
      minOpacity?: number;
      maxZoom?: number;
      max?: number;
      radius?: number;
      blur?: number;
      gradient?: Record<number, string>;
    }
  ): L.Layer;
}
