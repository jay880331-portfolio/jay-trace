// react-native은 optional peer dependency라 실제 타입 패키지가 없다.
// tsc가 `import ... from "react-native"`를 해석할 수 있도록 최소 타입만 로컬로 선언한다.
// 런타임에는 Metro가 실제 react-native 모듈을 해석하며, 이 선언은 dist 산출물에 포함되지 않는다.
declare module "react-native" {
  import type { ComponentType } from "react";

  export const View: ComponentType<{
    style?: unknown;
    onTouchStart?: (event: unknown) => void;
    [key: string]: unknown;
  }>;

  export const AppState: {
    currentState?: string;
    addEventListener?: (
      type: "change",
      listener: (state: string) => void
    ) => { remove?: () => void } | (() => void) | void;
  };
}
