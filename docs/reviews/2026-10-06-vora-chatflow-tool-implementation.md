# Vora Chatflow Tool 구현 및 검증 기록

작성일: 2026-10-06

상태: Flowise와 Flowise-Worker의 구현·자동 테스트·빌드·격리 UI 검증 완료. 사용자가 두 저장소의 커밋·푸시를 승인했다. 운영 배포 완료 여부와 운영 워크플로우 전환은 별도 검증 대상이다.

두 저장소의 작업 브랜치는 `feature/vora-chatflow-tool`이다. 변경 전 기준은 Web `4fae96f1a5cd252b1ef36682024ebd214b4733c4`, Worker `c6258f69f13d942bc054ad5a90a105d66a4155bc`이다.

최종 분리 범위는 항상 enabled인 무료 도구로 확정했다. 요청별 disabled 상속과 노드 ID 변환표는 추가하지 않는다. 사용자와 잔여량 전달은 기존 설계대로 유지하며 VORA 서비스 코드는 변경하지 않는다.

## 1. 최신 제보: 자식 Return Direct ON / Vora OFF에서 도구 내역 누락

기존 보강 ChatflowTool의 일반 JSON 경로는 자식 응답을 읽은 뒤 `return resp.text`만 실행했다. `usedTools` 수집은 부모의 SSE streamer가 있고 ChatflowTool의 Return Direct가 ON일 때만 진입하는 별도 helper에 있었다. 따라서 OFF 경로에서는 자식이 정상적으로 도구 내역을 반환해도 부모가 이를 버렸다. 자식 도구의 Return Direct를 OFF로 바꿔서 해결할 문제는 아니다.

새 Vora 노드는 JSON/SSE 처리를 `readChildPrediction`으로 통합했다. JSON 응답에서도 `usedTools`를 호출별 `flowConfig`에 담고, 공통 실행기가 부모의 공개 도구 목록에 합친다. Vora 중계 도구의 내부 실행 기록은 유지하며 공개 목록에서만 제외한다. 도구 이름이나 canvas node ID로 필터링하지 않는다.

양쪽 저장소에서 커밋된 기존 보강 노드와 빌드된 신규 노드를 같은 로컬 HTTP endpoint에 직접 호출하여 비교했다. 기존 코드는 메모리에서 컴파일했으며 소스나 빌드 산출물을 덮어쓰지 않았다.

| 항목                             | 기존 보강 ChatflowTool OFF | 신규 VoraChatflowTool OFF |
| -------------------------------- | -------------------------- | ------------------------- |
| 자식 텍스트 수신                 | 성공                       | 성공                      |
| 자식 prediction 요청 수          | 1회                        | 1회                       |
| 자식 usedTools 수신 후 부모 전달 | 누락                       | 이름·입력·결과 보존       |

실제 HTTP 클라이언트와 부모·자식 ToolAgent를 함께 실행한 통합 테스트에서도 다음을 확인했다.

-   자식 ON / Vora OFF에서는 자식 원시 도구 결과를 부모 LLM이 받아 최종 답변을 작성한다.
-   자식 호출은 JSON으로 처리하며, 부모 답변의 스트리밍은 그대로 가능하다.
-   부모 최종 JSON과 SSE `usedTools`에 자식 도구가 존재한다.
-   Vora 중계 도구는 공개 도구 목록에 나타나지 않는다.
-   자식 ON/OFF × Vora ON/OFF × 부모 SSE/JSON의 8가지 조합 모두 동일한 도구 내역 계약을 만족한다.

위 비교는 로컬 fixture 검증이다. 운영 서버가 새 코드를 실행한다는 증거로 사용하지 않는다.

## 2. 구현된 계약

-   신규 타입/이름 `VoraChatflowTool`, 표시 이름 `Vora Chatflow Tool`, 버전 1.0, Tools 분류. 기존 노드와 함께 검색·배치 가능하다.
-   VoraRouter2의 `voraRouter.png`와 바이트 단위로 같은 아이콘을 사용한다. 공용 `chatflowApi` credential 아이콘을 덮어쓰지 않는다.
-   기존 `ChatflowTool.ts`는 공식 원본 blob `a2ae7cc8172e70c6edf644be749ee9d2d1c3ffa4`와 정확히 일치한다. 원본 변경 커밋은 `3f257bdc8196082a178da7134a075824401b13b9`이다.
-   저장된 `ChatflowTool`을 신규 타입으로 자동 전환하지 않는다. 기존 타입은 복구한 원본 동작으로 실행된다.
-   부모에 실제 적용된 `vars.user_id`, `vars.tool_usage`만 자동 전달한다. 부모와 자식 모두 API Override 및 해당 Variables 허용이 필요하다.
-   `tool_usage`는 TOOL_CODE를 키로 하는 전체 JSON 문자열이다. 워크플로우마다 다른 node ID를 복사하거나 대응시키지 않는다.
-   부모 user_id가 없거나 올바른 문자열이 아니면 실제 자식 호출 시점에 오류로 처리한다. 허브를 호출하지 않은 일반 질의의 노드 초기화는 가능하다.
-   부모 tool_usage가 없으면 빈 문자열을 전달하여 자식의 고정 quota 값을 남기지 않는다. 무료 도구의 기존 값 없음 정책은 유지한다.
-   Override Config 기본값은 빈 객체이며 다른 명시적 자식 설정은 유지한다. 예약된 user_id/tool_usage는 현재 부모 값이 우선한다.
-   부모의 toolEnabled map, 시스템 프롬프트, 모델 설정과 나머지 vars는 자동 복사하지 않는다. 메인 도구의 추가·삭제에 종속된 고정 목록이 없다.
-   Tool Enabled는 기본 ON이며 false일 때 모델에 바인딩되지 않는다. 부모에 없는 node ID의 override map을 신규 노드의 false로 오해하지 않는다.
-   기본 sessionId는 부모 것을 사용한다. 자식 chatId는 JSON/SSE 모두 호출마다 별도로 생성한다. 새 세션 옵션과 명시 sessionId 설정은 지원한다.
-   자식 prediction은 실행당 한 번만 요청한다. 무토큰 완료, 오류, 스트림 중단 때 재호출하지 않는다.
-   SSE UTF-8 분할, LF/CRLF, 완료·오류·중단·불완전 EOF를 구분한다. 자식 metadata/end 이벤트가 부모 채널을 덮어쓰거나 종료하지 않는다.
-   도구 내역 snapshot을 반복해서 더하지 않으며, 실제 반복 실행된 같은 이름의 도구는 보존한다.
-   자식 원시 결과가 부모 답변에 재출력되지 않도록 기존 direct-return receipt를 유지한다. 직접 전달 중 실패하면 부분 답변을 재생하지 않고 오류 안내를 한 번 표시한다.

## 3. 변경 파일

두 저장소의 아래 14개 코드·테스트·아이콘 파일은 최종 바이트 비교에서 일치했다.

-   `packages/components/nodes/tools/VoraChatflowTool/`: 신규 노드, `childPrediction.ts`, PNG 및 3개 테스트 파일 — 6개.
-   `packages/components/nodes/tools/ChatflowTool/ChatflowTool.ts`: 원본 복구.
-   `packages/components/src/transparentTool.ts`: 인스턴스/호출별 비공개 표식과 공개 내역 필터.
-   `packages/components/src/Interface.ts`: 호출별 결과·신호 타입, credential 아이콘 등록 제외 옵션.
-   `packages/components/src/agents.ts`: 내부 실행 기록 보존, 공개 중계 항목 제외, 자식 내역 병합.
-   `packages/components/nodes/agents/ToolAgent/ToolAgent.streaming.test.ts`: 직접 반환·합성·실패 회귀.
-   `packages/server/src/NodesPool.ts`: 공용 credential 아이콘 보호.
-   `packages/server/src/NodesPool.vora.test.ts`: 등록 순서와 노드 정의 검증.
-   `packages/server/src/utils/voraChatflowOverrides.test.ts`: 실제 override 허용 경로와 워크플로우별 node ID 검증.

`vora_service`, 운영 DB, Upstash, 환경 파일, 실제 부모·자식 그래프와 시스템 프롬프트는 수정하지 않았다.

## 4. 검증 결과

Node 20.20.2를 사용했다. `pnpm test --filter=flowise-components --filter=./packages/server -- --runInBand`와 해당 패키지의 최종 회귀 테스트를 실행했다.

| 저장소         |                   components |                       server | 루트 필터 빌드 |
| -------------- | ---------------------------: | ---------------------------: | -------------- |
| Flowise        | 34 suites / 1,113 tests 통과 | 54 suites / 1,061 tests 통과 | 3 tasks 성공   |
| Flowise-Worker | 34 suites / 1,113 tests 통과 | 51 suites / 1,053 tests 통과 | 3 tasks 성공   |

Worker의 최초 전체 실행은 components 1,112개였다. 직접 반환 오류 안내 테스트를 추가한 최종 components 전체 실행에서 1,113개를 통과했다. 마지막으로 8가지 조합의 공개 SSE/JSON 도구 내역 assertion을 보강하고, 두 저장소의 실제 HTTP 통합 테스트 10개씩을 다시 통과했다.

빌드 명령은 `pnpm build --filter=flowise-components --filter=./packages/server`이다. 변경 파일 ESLint와 `git diff --check`도 통과했다. 전체 루트 lint를 통과했다고 주장하지 않는다.

통합 테스트는 실제 secureFetch, 부모·자식 ToolAgent와 로컬 HTTP 서버를 사용한다. LLM 응답과 무료 검색 함수는 fixture다. 외부 제공자 호출·과금, 실제 Upstash 저장, 운영 Queue 포화는 이 테스트에 포함되지 않는다.

UI는 격리한 임시 SQLite/저장소와 실제 빌드 서버에서 Playwright로 확인했다. 운영 환경 파일을 로드하지 않았다.

-   `chatflow` 검색 결과에 두 노드 표시, 서로 다른 아이콘 확인.
-   Vora 추가 설정의 Tool Enabled 기본 ON, Return Direct 기본 OFF 확인.
-   원본/Vora 노드를 ToolAgent에 연결한 3개 노드·2개 연결 저장 후 새로고침.
-   노드 타입, 입력 값, Return Direct OFF, 아이콘과 2개 연결 유지 확인.
-   재열기 후 브라우저 console 오류·경고 0개. 테스트 계정과 그래프는 격리 DB에만 존재한다.
-   확인 후 테스트 브라우저와 서버 종료.

UI 이미지와 기존/신규 HTTP 비교 결과는 Web 저장소 `output/playwright/vora-chatflow-tool/`에 보관한다. 실행 로그는 `/tmp/vora-web-full-tests.log`, `/tmp/vora-worker-full-tests.log`, `/tmp/vora-worker-final-components.log`, `/tmp/vora-web-metadata-tests.log`, `/tmp/vora-worker-metadata-tests.log`, `/tmp/vora-web-build.log`, `/tmp/vora-worker-build.log`에 있다.

## 5. 실제 자식 생성·배포 후 확인할 사항

현재 완료 범위는 승인된 설계의 A단계인 노드 기능 구현과 fixture 검증이다. 실제 무료 도구 자식이 준비되면 B단계를 수행해야 한다.

-   실제 자식의 user_id/tool_usage override 허용과 도구 함수 수신값 확인.
-   Web과 Worker 양쪽 배포 후 신규 타입 사용. 기존 저장 노드를 자동 교체하지 않는다.
-   VORA 화면의 자식 도구 표시·한도 처리와 실제 최종 답변 확인.
-   같은 Upstash/sessionId에서 부모·자식이 남기는 메모리 기록량 확인.
-   같은 prediction queue의 부모 작업이 자식을 기다리는 중첩 구조에서 슬롯 포화·취소 전파 확인.
-   최종 무료 도구 분리 후 provider tools/usage를 비교하여 실제 토큰 절감 측정.

세부 설계는 `2026-10-06-vora-chatflow-tool-design.md`를 참조한다.
