export interface ImageDetectionResult {
  position: Position;
  size: Size;
  confidence: number;
}

export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}
