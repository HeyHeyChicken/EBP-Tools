// Copyright (c) 2026, Antoine Duval
// This file is part of a source-visible project.
// See LICENSE for terms. Unauthorized use is prohibited.

class Position {
  constructor(
    public x: number,
    public y: number
  ) {}
}

class ScoreFrame {
  constructor(
    public orangeLogo: Position,
    public blueLogo: Position,
    public orangeName: [Position, Position],
    public blueName: [Position, Position],
    public orangeScore: [Position, Position],
    public blueScore: [Position, Position]
  ) {}
}

class EndFrame {
  constructor(
    public orangeScore: [Position, Position],
    public blueScore: [Position, Position]
  ) {}
}

class GameFrame {
  constructor(
    public playersX: [number, number],
    public map: [Position, Position],
    public orangeName: [Position, Position],
    public blueName: [Position, Position],
    public timer: [Position, Position],
    public orangePlayersX: [number, number],
    public bluePlayersX: [number, number],
    public playersY: [
      [number, number],
      [number, number],
      [number, number],
      [number, number]
    ]
  ) {}
}

class LoadingFrame {
  constructor(
    public logoTop: Position,
    public logoLeft: Position,
    public logoRight: Position,
    public logoMiddle: Position,
    public logoBlack1: Position,
    public logoBlack2: Position,
    public logoBlack3: Position,
    public logoBlack4: Position
  ) {}
}

class Mode {
  constructor(
    public scoreFrame: ScoreFrame,
    public endFrame: EndFrame,
    public gameFrame: GameFrame,
    public loadingFrames: LoadingFrame[]
  ) {}
}

export const MODES = [
  //#region Mode 0

  new Mode(
    new ScoreFrame(
      new Position(325, 153), // orangeLogo
      new Position(313, 613), // blueLogo
      [new Position(390, 187), new Position(620, 217)], // orangeName
      [new Position(390, 637), new Position(620, 667)], // blueName
      [new Position(530, 89), new Position(620, 127)], // orangeScore
      [new Position(1285, 89), new Position(1384, 127)] // blueScore
    ),
    new EndFrame(
      [new Position(636, 545), new Position(903, 648)], // orangeScore
      [new Position(996, 545), new Position(1257, 648)] // blueScore
    ),
    new GameFrame(
      [118, 1801], // playersX
      [new Position(825, 81), new Position(1093, 102)], // map
      [new Position(686, 22), new Position(833, 68)], // orangeName
      [new Position(1087, 22), new Position(1226, 68)], // blueName
      [new Position(935, 0), new Position(985, 28)], // timer
      [127, 384], // orangePlayersX
      [1541, 1799], // bluePlayersX
      [
        [732, 755],
        [814, 838],
        [898, 921],
        [980, 1004]
      ] // playersY
    ),
    [
      new LoadingFrame(
        new Position(958, 427),
        new Position(857, 653),
        new Position(1060, 653),
        new Position(958, 642),
        new Position(958, 463),
        new Position(880, 653),
        new Position(1037, 653),
        new Position(958, 610)
      ),
      new LoadingFrame(
        new Position(959, 484),
        new Position(908, 596),
        new Position(1010, 596),
        new Position(959, 589),
        new Position(959, 503),
        new Position(920, 596),
        new Position(996, 596),
        new Position(959, 573)
      ),
      new LoadingFrame(
        new Position(959, 369),
        new Position(808, 708),
        new Position(1110, 708),
        new Position(959, 708),
        new Position(959, 430),
        new Position(840, 708),
        new Position(1070, 708),
        new Position(959, 640)
      )
    ]
  ),

  //#endregion
  //#region Mode 1

  new Mode(
    new ScoreFrame(
      new Position(325, 123), // orangeLogo
      new Position(313, 618), // blueLogo
      [new Position(388, 159), new Position(618, 189)], // orangeName
      [new Position(390, 629), new Position(620, 679)], // blueName
      [new Position(530, 54), new Position(620, 92)], // orangeScore
      [new Position(1286, 54), new Position(1376, 93)] // blueScore
    ),
    new EndFrame(
      [new Position(636, 545), new Position(903, 648)], // orangeScore
      [new Position(996, 545), new Position(1257, 648)] // blueScore
    ),
    new GameFrame(
      [118, 1801], // playersX
      [new Position(825, 89), new Position(1093, 110)], // map
      [new Position(686, 22), new Position(833, 68)], // orangeName
      [new Position(1087, 22), new Position(1226, 68)], // blueName
      [new Position(935, 0), new Position(985, 28)], // timer
      [131, 384], // orangePlayersX
      [1541, 1799], // bluePlayersX
      [
        [703, 729],
        [793, 819],
        [883, 908],
        [973, 998]
      ] // playersY
    ),
    [
      new LoadingFrame(
        new Position(958, 427),
        new Position(857, 653),
        new Position(1060, 653),
        new Position(958, 642),
        new Position(958, 463),
        new Position(880, 653),
        new Position(1037, 653),
        new Position(958, 610)
      ),
      new LoadingFrame(
        new Position(959, 484),
        new Position(908, 596),
        new Position(1010, 596),
        new Position(959, 589),
        new Position(959, 503),
        new Position(920, 596),
        new Position(996, 596),
        new Position(959, 573)
      )
    ]
  ),

  //#endregion
  //#region Mode 2

  new Mode(
    new ScoreFrame(
      new Position(325, 126), // orangeLogo
      new Position(313, 618), // blueLogo
      [new Position(388, 159), new Position(620, 196)], // orangeName
      [new Position(388, 641), new Position(620, 677)], // blueName
      [new Position(530, 54), new Position(620, 92)], // orangeScore
      [new Position(1286, 54), new Position(1376, 93)] // blueScore
    ),
    new EndFrame(
      [new Position(636, 545), new Position(903, 648)], // orangeScore
      [new Position(996, 545), new Position(1257, 648)] // blueScore
    ),
    new GameFrame(
      [118, 1801], // playersX
      [new Position(825, 89), new Position(1093, 110)], // map
      [new Position(686, 22), new Position(833, 68)], // orangeName
      [new Position(1087, 22), new Position(1226, 68)], // blueName
      [new Position(935, 0), new Position(985, 28)], // timer
      [124, 385], // orangePlayersX
      [1539, 1800], // bluePlayersX
      [
        [707, 732],
        [796, 821],
        [885, 909],
        [974, 998]
      ] // playersY
    ),
    [
      new LoadingFrame(
        new Position(958, 427),
        new Position(857, 653),
        new Position(1060, 653),
        new Position(958, 642),
        new Position(958, 463),
        new Position(880, 653),
        new Position(1037, 653),
        new Position(958, 610)
      ),
      new LoadingFrame(
        new Position(959, 484),
        new Position(908, 596),
        new Position(1010, 596),
        new Position(959, 589),
        new Position(959, 503),
        new Position(920, 596),
        new Position(996, 596),
        new Position(959, 573)
      )
    ]
  ),

  //#endregion
  //#region Mode 3

  new Mode(
    new ScoreFrame(
      new Position(314, 157), // orangeLogo
      new Position(299, 621), // blueLogo
      [new Position(390, 187), new Position(620, 217)], // orangeName
      [new Position(390, 637), new Position(620, 667)], // blueName
      [new Position(530, 89), new Position(620, 127)], // orangeScore
      [new Position(1285, 89), new Position(1384, 127)] // blueScore
    ),
    new EndFrame(
      [new Position(636, 545), new Position(903, 648)], // orangeScore
      [new Position(996, 545), new Position(1257, 648)] // blueScore
    ),
    new GameFrame(
      [118, 1801], // playersX
      [new Position(825, 79), new Position(1093, 99)], // map
      [new Position(686, 22), new Position(833, 68)], // orangeName
      [new Position(1087, 22), new Position(1226, 68)], // blueName
      [new Position(935, 0), new Position(985, 28)], // timer
      [127, 384], // orangePlayersX
      [1541, 1799], // bluePlayersX
      [
        [732, 755],
        [814, 838],
        [898, 921],
        [980, 1004]
      ] // playersY
    ),
    [
      new LoadingFrame(
        new Position(958, 427),
        new Position(857, 653),
        new Position(1060, 653),
        new Position(958, 642),
        new Position(958, 463),
        new Position(880, 653),
        new Position(1037, 653),
        new Position(958, 610)
      ),
      new LoadingFrame(
        new Position(959, 484),
        new Position(908, 596),
        new Position(1010, 596),
        new Position(959, 589),
        new Position(959, 503),
        new Position(920, 596),
        new Position(996, 596),
        new Position(959, 573)
      )
    ]
  ),

  //#endregion
  //#region Mode 4

  new Mode(
    new ScoreFrame(
      new Position(326, 192), // orangeLogo
      new Position(313, 607), // blueLogo
      [new Position(388, 221), new Position(619, 249)], // orangeName
      [new Position(390, 627), new Position(620, 655)], // blueName
      [new Position(539, 132), new Position(620, 172)], // orangeScore
      [new Position(1281, 132), new Position(1381, 169)] // blueScore
    ),
    new EndFrame(
      [new Position(636, 548), new Position(902, 640)], // orangeScore
      [new Position(983, 550), new Position(1236, 633)] // blueScore
    ),
    new GameFrame(
      [118, 1801], // playersX
      [new Position(825, 73), new Position(1094, 93)], // map
      [new Position(686, 22), new Position(833, 67)], // orangeName
      [new Position(1087, 22), new Position(1225, 56)], // blueName
      [new Position(935, 0), new Position(985, 24)], // timer
      [127, 384], // orangePlayersX
      [1541, 1799], // bluePlayersX
      [
        [732, 755],
        [814, 838],
        [898, 921],
        [980, 1004]
      ] // playersY
    ),
    [
      new LoadingFrame(
        new Position(959, 438),
        new Position(857, 643),
        new Position(1060, 642),
        new Position(958, 642),
        new Position(959, 470),
        new Position(880, 645),
        new Position(1034, 643),
        new Position(959, 604)
      )
    ]
  ),

  //#endregion
  //#region Mode 5

  new Mode(
    new ScoreFrame(
      new Position(319, 123), // orangeLogo
      new Position(313, 613), // blueLogo
      [new Position(379, 157), new Position(620, 194)], // orangeName
      [new Position(384, 638), new Position(620, 677)], // blueName
      [new Position(529, 54), new Position(618, 96)], // orangeScore
      [new Position(1282, 57), new Position(1375, 96)] // blueScore
    ),
    new EndFrame(
      [new Position(636, 545), new Position(903, 648)], // orangeScore
      [new Position(996, 545), new Position(1257, 648)] // blueScore
    ),
    new GameFrame(
      [118, 1801], // playersX
      [new Position(825, 81), new Position(1093, 102)], // map
      [new Position(686, 22), new Position(833, 68)], // orangeName
      [new Position(1087, 22), new Position(1226, 68)], // blueName
      [new Position(935, 0), new Position(985, 28)], // timer
      [127, 384], // orangePlayersX
      [1541, 1799], // bluePlayersX
      [
        [732, 755],
        [814, 838],
        [898, 921],
        [980, 1004]
      ] // playersY
    ),
    [
      new LoadingFrame(
        new Position(958, 427),
        new Position(857, 653),
        new Position(1060, 653),
        new Position(958, 642),
        new Position(958, 463),
        new Position(880, 653),
        new Position(1037, 653),
        new Position(958, 610)
      ),
      new LoadingFrame(
        new Position(959, 484),
        new Position(908, 596),
        new Position(1010, 596),
        new Position(959, 589),
        new Position(959, 503),
        new Position(920, 596),
        new Position(996, 596),
        new Position(959, 573)
      ),
      new LoadingFrame(
        new Position(959, 369),
        new Position(808, 708),
        new Position(1110, 708),
        new Position(959, 708),
        new Position(959, 430),
        new Position(840, 708),
        new Position(1070, 708),
        new Position(959, 640)
      )
    ]
  )

  //#endregion
];
