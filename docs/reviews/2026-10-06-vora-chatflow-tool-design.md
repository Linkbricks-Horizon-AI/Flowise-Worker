# Vora Chatflow Tool 최종 상세 설계

작성일: 2026-10-06

상태: 승인된 설계 기준. 최초 설계 작성 때는 코드를 변경하지 않았으며, 이후 사용자가 두 저장소의 구현을 승인했다. 구현·검증 결과는 별도 구현 기록에 정리한다. 운영 워크플로우·DB 설정·배포는 이 설계서로 변경하지 않는다.

현재 단계: 운영 자식 워크플로우는 아직 생성·분리하지 않았다. `test_sub Chatflow.json`은 구조 예제이며 운영 배포본이나 확정된 무료 도구 목록이 아니다. 신규 노드 구현을 먼저 완료할 수 있도록 노드 기능과 실제 워크플로우 구성·전환을 분리한다.

## 1. 목표와 확정 범위

메인 ToolAgent에 직접 연결된 일반 무료 검색·조회 도구를 자식 Chatflow로 분리한다. 메인 모델에는 분리된 도구 각각의 설명·스키마 대신 Vora Chatflow Tool의 짧은 설명과 질문 입력 스키마를 제공한다.

신규 노드는 부모의 **현재 API 요청에서 허용·적용된 `overrideConfig.vars.user_id`**와 현재 요청에 제공된 **`vars.tool_usage`**를 자식에게 전달한다. 자식의 도구 사용 내역은 부모의 공개 사용 목록에 평탄화하고, 중계 역할인 Vora Chatflow Tool 자체는 그 목록에서 숨긴다.

확정된 조건:

-   개인 자료실, 캘린더, 문서 편집기는 메인에 유지한다. 기존 유료 도구의 권한·과금 제어도 유지한다.
-   분리 대상은 항상 enabled로 사용하는 무료 도구로 한정한다. 요청별 disabled 처리가 필요한 도구는 이번 자식 분리 대상에 포함하지 않는다. 부모의 개별 `toolEnabled` 맵을 자식에게 자동 전달하지 않으며 ID 변환표도 추가하지 않는다. 잔여량 검사는 전달된 `tool_usage`로 유지한다.
-   자동 상속하는 업무 변수는 `vars.user_id`와 `vars.tool_usage`로 제한한다. 무료 도구에도 월간 한도 검사가 있으므로 사용자 ID만 전달하는 초기안은 이 두 변수 전달로 보완한다. `sessionId`는 대화 연속성을 위해 별도로 유지한다.
-   부모와 자식은 같은 Upstash 저장소를 사용한다. 세션 분리, 이력 축소, 요약, TTL 변경을 이번 기능에 섞지 않는다.
-   신규 이름은 `Vora Chatflow Tool`, 아이콘은 VoraRouter2의 기존 `voraRouter.png`와 동일하다.
-   Add Nodes의 LangChain → Tools에 원본 Chatflow Tool과 함께 표시한다.
-   기존 Chatflow Tool의 노드 파일을 공식 원본으로 복구한다. 저장된 기존 노드를 신규 타입으로 자동 이관하지 않는다.
-   기존 `ChatflowTool`이 원본 동작으로 바뀌어 자식 실시간 전달·자식 도구 전달을 잃는 영향은 사용자가 수용했다.
-   자식의 ID·이름·도구 수·모델·프롬프트를 노드 코드에 고정하지 않는다. 검색 외 무료 도구를 묶은 다른 자식에도 같은 노드 타입을 사용할 수 있게 한다.
-   메인의 도구도 추후 추가·삭제될 수 있다. 부모 도구 목록을 고정하거나 도구 이름·캔버스 ID로 중계 노드를 분류하지 않는다. 실행별 실제 인스턴스 표식으로 중계 호출만 제외한다.

## 2. 검토 기준과 확인된 현재 구조

| 프로젝트       | 브랜치 / 기준 SHA                                 | 역할                                    |
| -------------- | ------------------------------------------------- | --------------------------------------- |
| Flowise        | main / `4fae96f1a5cd252b1ef36682024ebd214b4733c4` | Web, UI, 공통 노드·실행 코드            |
| Flowise-Worker | main / `c6258f69f13d942bc054ad5a90a105d66a4155bc` | Queue 작업 실행                         |
| vora_service   | main / `d5476a738b38ffd0bdfea186e12f36b593b8cfb2` | 인증 사용자 변수 구성, 서비스 표시·과금 |

검토한 내보내기 파일: `/Users/yunsungji/Downloads/VORA-SERVICE-MAIN-WORKFLOW-OPENROUTER-CORE-1 Chatflow (2).json`.

-   Custom Tool 79개와 Calculator 1개가 메인 `toolAgent_0`에 직접 연결되어 있다.
-   저장된 Custom Tool 79개의 `toolEnabled`는 true이다. 실제 요청에서는 VORA의 override로 일부가 제외될 수 있다.
-   ToolAgent는 인스턴스가 남은 도구들을 `model.bindTools(tools)`로 모델에 연결한다.
-   내보내기 JSON은 nodes/edges만 포함한다. 워크플로우의 API Override 허용 설정과 실제 Custom Tool 함수·스키마는 이 파일만으로 확인할 수 없다.
-   현재 보강된 ChatflowTool, CustomTool, ToolAgent, 공통 agents, Upstash 메모리의 검토 대상 파일은 두 저장소에서 동일하다. Web/Worker의 `buildChatflow.ts` 전체는 차이가 있으므로 통째로 복사하면 안 된다.

주요 코드 근거:

-   `packages/server/src/utils/index.ts`: `buildFlow`, `replaceInputsWithConfig`, `resolveVariables`, `getAPIOverrideConfig`
-   `packages/components/nodes/tools/CustomTool/CustomTool.ts`: `toolEnabled` 처리, 실제 도구 로딩
-   `packages/components/src/utils.ts`: `getVars`, 요청 변수를 자식 Custom Tool의 `$vars`에 반영
-   `packages/components/nodes/tools/ChatflowTool/ChatflowTool.ts`: 현재 보강된 자식 호출·스트림 구현
-   `packages/components/src/agents.ts`, `directToolReturn.ts`: 내부 도구 실행 기록과 직접 반환
-   VORA `override-config.builder.ts`: 인증된 사용자로 `vars.user_id` 구성
-   VORA `tool-quota-exhausted.utils.ts`: 공개 도구 목록이 비었을 때 reasoning에서 복원하는 경로

### 2.1 자식 구조 예제 검토

파일: `/Users/yunsungji/Downloads/test_sub Chatflow.json`.

SHA-256: `0358833987f1d486f9d474d453566927436a1dd0456e69d43f3646dc6a217b48`.

| 항목           | 파일에서 확인한 내용                                                      |
| -------------- | ------------------------------------------------------------------------- |
| 최상위 구성    | nodes / edges만 존재, API Override 설정과 배포된 Chatflow ID 없음         |
| 실행 구조      | ToolAgent 1개 + VoraRouter2 1개 + Upstash 메모리 1개                      |
| 도구           | Custom Tool 25개 + Calculator 1개, 모두 Agent에 연결                      |
| 도구 활성화    | Custom Tool 25개 모두 저장값 true                                         |
| 연결           | 28개 edge, source/target 노드 존재 확인                                   |
| 모델           | VoraRouter2 사용, streaming true. 모델 선택은 자식 워크플로우 설정        |
| 메모리         | sessionId 비어 있음, memoryKey chat_history, TTL 2,764,800초(32일)        |
| 프롬프트       | 12,743자. 전체 도구 스키마 분량이나 실제 provider 토큰 수를 의미하지 않음 |
| 실제 도구 정의 | selectedTool 참조만 있고 customToolFunc/Schema 등 인라인 정의는 비어 있음 |

메인 export의 메모리도 sessionId 비어 있음, TTL 2,764,800초로 예제와 일치했다. 실제 생성할 자식에서는 사용자가 지정한 동일 Upstash credential과 세션 규칙을 다시 확인한다.

예제는 일반 검색·위키·음악·장소·이미지·동영상·의약품·공시·경제·나라장터·시간·운세 등 여러 종류를 보여준다. 동시에 `Advanced search (paid tier-1/2/3)` 메모와 특허·학술·항공·호텔·SEC 등의 노드도 포함한다. 이 라벨만으로 현재 과금 상태를 확정하지 않으며, 예제 전체를 무료 운영 자식으로 자동 배포하지 않는다. 최종 분리 대상은 추후 실제 카탈로그와 도구 함수를 확인하여 선정한다.

메인과 예제의 식별자 차이:

| 동일 캔버스 ID | 메인 export                           | 자식 예제                                   |
| -------------- | ------------------------------------- | ------------------------------------------- |
| customTool_11  | vora_tool_generation_text_to_avatar   | vora_tool_search_game                       |
| customTool_16  | vora_tool_document_text_to_word_basic | vora_tool_search_imdb                       |
| customTool_52  | vora_tool_search_nara                 | 표시 이름은 같지만 selectedTool 참조가 다름 |

캔버스 node ID는 워크플로우 내부 식별자이다. **같은 도구라도 부모와 자식의 node ID가 다를 수 있으며, 같은 node ID가 서로 다른 도구를 가리킬 수도 있다.** 부모와 자식의 ID 일치 여부로 같은 도구인지 판단하거나 자동 매핑하지 않는다. 위 표는 두 예제 파일의 우연한 ID 중복을 보여줄 뿐, 도구 매핑 표가 아니다.

| 식별자                | 용도와 적용 범위                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| 캔버스 node ID        | 해당 워크플로우 안의 노드 배치·연결·노드별 override 대상. 워크플로우 간 도구 식별자로 사용하지 않음 |
| selectedTool          | 노드가 실제로 불러오는 저장된 Custom Tool 정의의 참조. 표시 이름만 보고 동일 정의라고 단정하지 않음 |
| 도구 함수의 TOOL_CODE | 기존 VORA 사용량 맵에서 해당 도구의 잔여량을 조회하는 키. 캔버스 node ID와 별개                     |

`tool_usage`는 전체 맵을 그대로 전달하므로 워크플로우 간 node ID 변환이 필요 없다. 각 자식 도구가 자기 코드의 TOOL_CODE로 조회한다. 부모의 node ID 기반 `toolEnabled` 맵을 자식에 그대로 전달하면 다른 도구에 적용될 수 있으므로 최종 설계에서는 이 맵을 자동 상속하지 않는다. 나중에 자식 노드별 override가 필요하면 그 자식의 실제 node ID로 별도 구성해야 한다.

예제는 노드 구조·입출력 검증의 참고 자료로만 사용한다. 파일을 수정하거나 import·실행·배포하지 않았다.

## 3. 신규 노드 정의와 UI

| 항목               | 설계 값                                           |
| ------------------ | ------------------------------------------------- |
| label              | `Vora Chatflow Tool`                              |
| name / type        | `VoraChatflowTool`                                |
| version            | `1.0`                                             |
| category           | `Tools`                                           |
| baseClasses        | `['VoraChatflowTool', 'Tool']`                    |
| tags               | 일반 LangChain 노드 분류를 따름                   |
| icon               | 기존 VoraRouter2와 바이트가 같은 `voraRouter.png` |
| credential         | 기존 `chatflowApi` 재사용                         |
| 모델에 노출할 입력 | `input: string`                                   |

노드 타입 이름과 사용자가 지정하는 Tool Name은 다르다. 예를 들어 노드 타입은 `VoraChatflowTool`, Tool Name은 `vora_tool_search_hub`가 될 수 있다. 도구 숨김 여부를 이 사용자 지정 이름으로 판정하지 않는다.

Select Chatflow는 현재 Flowise의 실제 선택 목록을 사용한다. 예제의 파일명을 API ID처럼 사용하지 않는다. 나중에 자식 워크플로우를 생성한 뒤 해당 ID를 선택하면 된다. 하나의 신규 노드 타입으로 여러 자식을 호출할 수 있으며, 부모에 여러 인스턴스를 둘 때 Tool Name은 서로 구분한다. 새 중계 도구를 개별 무료 도구마다 만들거나 VORA 도구 카탈로그에 과금 도구로 등록할 필요는 없다.

기존 입력 필드는 유지한다: Select Chatflow, Tool Name, Tool Description, Return Direct, Override Config, Base URL, Start new session per message, Use Question from Chat, Custom Input.

신규 `Tool Enabled`는 기본 true로 둔다. 무료 검색 허브에서는 그대로 사용한다. 부모에서 허브 전체를 제어해야 할 경우에만 이 입력의 API override를 허용한다. false 또는 문자열 'false'이면 null을 반환하여 메인 모델의 도구 목록에서 제외한다. 기존 generic override가 관계없는 노드의 입력에 맵 객체를 남기는 경우를 오류로 처리하지 않는다.

`user_id`·`tool_usage`를 직접 적는 입력란이나 전체 부모 override 상속 토글은 만들지 않는다. 노드 설명에는 “부모 요청에 적용된 사용자와 도구 잔여량 정보를 자동 전달하며 부모·자식의 변수 override 허용이 필요함”을 명시한다.

기존 Return Direct / Use Question from Chat의 일반 기본 동작은 유지한다. 사용자의 후속 선택에 따른 운영 구성 안내는 **자식 도구 Return Direct ON / 부모 Vora Chatflow Tool Return Direct OFF**이다. 부모 LLM이 자식의 결과와 메인 도구 결과를 종합하고 최종 페르소나·출력 규칙을 적용한다. 자식 내부에서 여러 검색을 이어서 수행해야 하는 도구는 OFF가 필요한지 실제 구성 단계에서 판단한다. 자식이 최종 답변을 담당하는 다른 구성에서는 Vora 노드를 ON으로 사용할 수 있으며 네 조합을 모두 지원한다. Start new session OFF, Override Config `{}`를 기본 안내로 사용한다. 운영 자식은 아직 생성·확정하지 않았으므로 실제 도구 설정을 일괄 변경하지 않는다.

NodesPool의 자동 파일 탐색을 사용하므로 별도의 하드코딩된 UI 노드 목록은 추가하지 않는다. `chatflow`, `vora` 검색, 아이콘 API, 캔버스 저장·재열기를 확인한다.

### 공유 credential 아이콘

현재 NodesPool은 노드 아이콘을 해당 credential 아이콘으로도 등록한다. 두 노드가 `chatflowApi`를 공유하면 탐색 순서에 따라 credential 아이콘까지 바뀔 수 있다. 신규 Vora 노드만 credential 아이콘 등록을 건너뛰는 선택 속성을 추가하고, 기본 동작은 기존대로 유지한다. 예: `skipCredentialIconRegistration?: boolean`.

## 4. 부모 user_id 취득과 우선순위

정상 경로:

```text
VORA 인증 세션
  → 부모 요청 overrideConfig.vars.user_id
  → 부모 API Override status + user_id 변수 허용 검사
  → replaceInputsWithConfig
  → 현재 요청의 nodeData.inputs.vars.user_id
  → VoraChatflowTool.init에서 요청별 값 복사
  → 자식 호출 overrideConfig.vars.user_id
  → 자식 API Override status + user_id 변수 허용 검사
  → 자식 CustomTool.getVars
  → 자식 도구의 $vars.user_id
```

결정 사항:

1. 신규 노드는 `nodeData.inputs.vars.user_id`에서 현재 요청에 적용된 값을 취득한다. 요청별 init 인스턴스에 값을 복사하며 모듈 전역·정적 필드·공유 credential에 저장하지 않는다.
2. `getVars`로 워크스페이스 기본값을 찾아 부모 사용자 대신 쓰지 않는다. `{{$vars.user_id}}` 문자열 치환에도 의존하지 않는다. 현재 서버의 일반 템플릿 해석과 요청 override 변수 적용 경로는 동일하지 않다.
3. LLM 입력 스키마에 user_id, vars, overrideConfig를 추가하지 않는다. 사용자가 질문에 적은 ID나 모델이 만든 ID를 전달 값으로 사용하지 않는다.
4. 부모 user_id는 자식 Override Config의 수동 `vars.user_id`보다 우선한다. 다른 ID가 적혀 있어도 부모의 현재 값이 최종값이다.
5. 값이 없거나 빈 문자열·문자열이 아닌 경우 **실제 도구 호출 시점에**, 자식 HTTP 요청 전에 명확한 설정 오류를 반환한다. 무료 허브를 호출하지 않은 일반 대화까지 init 단계에서 실패시키지 않는다.
6. 오류 메시지는 부모의 API Override와 user_id 허용 설정을 확인하도록 안내한다. 실제 사용자 ID나 credential을 오류에 넣지 않는다.

허용 상태가 꺼져 있으면 자동으로 설정을 켜지 않는다. 특히 자식 허용 설정이 꺼지면 Flowise가 전달 값을 무시할 수 있으므로, 자식의 실제 수신값 검증은 워크플로우 전환의 필수 조건이다.

### 무료 도구의 tool_usage 상속

사용자가 제공한 무료 도구 헤더는 `$vars.tool_usage`의 JSON 문자열을 읽어 자기 `TOOL_CODE`의 잔여량이 0이면 `QUOTA_EXHAUSTED:<toolCode>`를 반환한다. 값이 없거나 해당 키가 없으면 검사를 통과한다. 따라서 “코드를 그대로 둘 수 있다”와 “현재 사용량 제한도 유지된다”는 별개이다.

VORA의 `agent-tool-availability.service.ts`는 무료 도구의 월 한도 소진 상태를 계산하고, `tool-usage.utils.ts`는 이를 0으로 변환한다. 무료 도구가 기본 enabled라고 해서 무제한인 것은 아니다. 부모에게 적용된 이 값은 같은 Upstash 세션을 쓴다고 자식의 vars로 자동 상속되지 않는다.

-   기존 도구의 `TOOL_CODE`와 잔여량 검사 코드는 유지한다. TOOL_CODE는 도구별 고정 식별자이므로 부모에서 별도로 전달할 필요가 없다.
-   `nodeData.inputs.vars.tool_usage`에 적용된 현재 값을 user_id와 같은 요청 범위에서 복사한다. VORA가 만든 JSON 문자열 형식을 그대로 유지한다.
-   이 문자열은 도구별 잔여량 전체 맵 하나이다. 자식 도구 수나 캔버스 ID에 맞춰 다시 만들지 않는다. 각 도구가 자기 TOOL_CODE로 값을 조회하므로 자식 구성 변경 시 신규 노드 코드나 override 양식을 바꿀 필요가 없다.
-   부모의 tool_usage가 있으면 자식의 수동 설정보다 우선한다. LLM이 잔여량을 생성하거나 수정하지 못하게 한다.
-   `toolEnabled` 맵은 여전히 상속하지 않는다. 활성화 여부와 실행 전 잔여량 검사는 다른 계약이다.
-   부모에 tool_usage가 없으면 잔여량을 임의로 만들거나 -1로 바꾸지 않는다. 자식에는 빈 문자열을 명시해 고정 워크스페이스 값으로 대체되는 것을 방지한다. 이는 기존 코드의 “값이 없으면 검사 생략” 동작을 유지하는 것이며, 무제한 권한을 확인했다는 의미가 아니다.
-   부모 값이 존재하면 문자열이어야 한다. 다른 타입은 도구 호출 전 설정 오류로 처리하며 문자열 강제 변환으로 의미를 바꾸지 않는다. 문자열은 재직렬화·필터링하지 않고 전달한다. 기존 도구의 잘못된 JSON 처리 정책을 이 작업에서 새로 바꾸지 않는다.
-   현재 VORA의 조회 실패 등에서 무료 도구를 계속 허용하는 정책과, 정상 요청의 값 전달 누락을 구분한다. 정상 요청에서 0 값이 사라지거나 자식의 허용 OFF 때문에 검사가 생략되면 검증 실패이다. 이 신규 노드 작업을 이유로 서비스의 장애 시 정책을 변경하지 않는다.
-   자식 워크스페이스의 고정 tool_usage를 현재 사용자 값 대신 사용하지 않도록 구성을 확인한다. 부모의 현재 문자열 또는 명시적인 빈 문자열이 실제 적용되어야 한다.
-   `QUOTA_EXHAUSTED` 도구 결과를 자식 usedTools에 보존하여 부모와 VORA가 기존 소진 안내·사용량 처리 경로를 사용할 수 있게 한다.
-   이 값은 부모 요청 시점의 스냅샷이다. 호출 간 원자적 quota 예약이나 동시 실행의 새 제한 체계를 구현하는 것은 아니다.

## 5. Override 병합 계약

| 값                                                  | 처리                                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 부모 `vars.user_id`                                 | 자동 상속, 최종 우선                                                                  |
| 부모 `vars.tool_usage`                              | 현재 요청에 있으면 같은 JSON 문자열을 자동 상속. 없으면 빈 문자열. 수동 설정보다 우선 |
| 부모 `sessionId`                                    | 기본 세션으로 사용                                                                    |
| 부모 `toolEnabled`                                  | 자동 상속하지 않음                                                                    |
| 부모 `systemMessage`, `customToolSchema`, 모델 설정 | 자동 상속하지 않음                                                                    |
| user_id / tool_usage 이외 부모 vars                 | 자동 상속하지 않음                                                                    |
| 신규 노드에 직접 설정한 Override Config             | 자식에 대한 명시적 설정으로 유지                                                      |
| 명시적 자식 vars의 다른 키                          | 로컬 설정을 유지할 수 있으나 이번 허브는 `{}` 사용                                    |
| 명시적 자식 `sessionId`                             | 기존 Chatflow Tool과 같이 기본 세션값보다 우선                                        |

개념상 요청 조립은 다음과 같다. 실행 코드가 아니라 계약 설명이다.

```ts
const explicitChildVars = { ...explicitChildOverride.vars }
delete explicitChildVars.user_id
delete explicitChildVars.tool_usage

const childOverride = {
    sessionId: startNewSession ? newSessionIdForThisCall : parentSessionId,
    ...explicitChildOverride,
    vars: {
        ...explicitChildVars,
        user_id: appliedParentUserId,
        tool_usage: appliedParentToolUsage ?? ''
    }
}
```

명시적 Override Config는 JSON 객체여야 하며 vars가 존재하면 객체여야 한다. 배열·문자열을 객체처럼 전개하지 않는다. 요청 직전에 정상 구조로 검증하고 JSON 직렬화를 사용한다.

부모 원본 override와 저장된 노드 설정 객체를 변경하지 않는다. 호출마다 새로운 body와 결과 수집 상태를 만든다.

tool_usage의 전체 맵을 전달해도 맵에 나온 도구를 생성·활성화하거나 그 도구의 스키마를 모델에 붙이지 않는다. 이 맵과 user_id는 프롬프트·도구 입력 스키마에 삽입하지 않는다. 자식으로 전달되는 요청 크기와 LLM 입력 토큰은 구분한다.

## 6. 부모·자식 설정 예시

VORA → 부모의 기존 요청 형식은 유지한다.

```json
{
    "question": "질문",
    "streaming": true,
    "overrideConfig": {
        "sessionId": "conversation-A",
        "vars": {
            "user_id": "user-U",
            "tool_usage": "{\"vora_tool_search_music\":1}"
        },
        "toolEnabled": { "customTool_45": false }
    }
}
```

신규 노드 → 자식의 기본 요청은 다음과 같다.

```json
{
    "question": "질문",
    "chatId": "child-execution-B",
    "streaming": true,
    "overrideConfig": {
        "sessionId": "conversation-A",
        "vars": {
            "user_id": "user-U",
            "tool_usage": "{\"vora_tool_search_music\":1}"
        }
    }
}
```

이 JSON은 자동 생성되는 HTTP 요청 예시이다. 사용자가 Override Config 입력창에 이 전체 body를 붙여 넣는 방식이 아니다. 신규 노드의 입력창은 `{}`로 두면 된다.

| 설정 위치       | 필수 설정                                                          |
| --------------- | ------------------------------------------------------------------ |
| 부모 워크플로우 | API Override ON, Variables의 user_id / tool_usage 허용             |
| 부모 Vora 노드  | 자식 선택, 도구 이름·짧은 설명, 유효한 API credential              |
| 자식 워크플로우 | API Override ON, Variables의 user_id / tool_usage 허용             |
| 자식 무료 도구  | 기본 enabled, `$vars.user_id` 및 기존 `$vars.tool_usage` 검사 사용 |
| 공유 메모리     | 동일 Upstash와 기본 부모 sessionId 사용                            |

기존 VORA user_id / tool_usage 생성 코드를 변경할 필요는 없다. 부모에 남는 개인 자료실·캘린더·편집기의 기존 vars와 schema override는 그대로 유지한다.

### 기본 사용 절차

1. 신규 노드 배포 후, 사용자가 검색 등 기타 무료 도구로 자식 워크플로우를 생성한다.
2. 자식의 실제 Custom Tool을 연결하고 기존 TOOL_CODE·tool_usage 검사 코드는 유지한다.
3. 부모와 자식에서 user_id 및 tool_usage의 override를 허용한다.
4. 부모에 Vora Chatflow Tool을 추가하여 생성한 자식을 선택한다.
5. Tool Name과 자식이 처리하는 범위를 짧게 설명한다. Override Config 입력창은 `{}`로 둔다.
6. user_id·잔여량·응답 모드·도구 목록 전달을 검증한 후 메인의 중복 직접 연결을 제거한다.

아직 운영 자식이 없다는 사실은 신규 노드 코드를 구현·단위 검증하는 데 장애가 아니다. 실제 워크플로우 생성과 운영 그래프 편집은 후속 전환 단계이다.

## 7. 실행과 스트리밍

### 호출 1회당 상태

신규 노드에서는 스트리밍·JSON 경로 모두 자식 호출별 chatId를 별도로 생성한다. 이는 현재 원본 노드의 모든 경로를 바꾸는 작업이 아니라 신규 노드의 규칙이다. 기본 sessionId는 부모와 같다.

| 부모 요청 | Return Direct | 자식 요청·반환                                                                                |
| --------- | ------------- | --------------------------------------------------------------------------------------------- |
| SSE       | ON            | 자식 SSE를 요청하고 답변 토큰을 부모로 전달                                                   |
| SSE       | OFF           | 자식 결과를 수집하여 부모 모델의 도구 결과로 제공. 자식 답변을 사용자 스트림에 바로 섞지 않음 |
| JSON      | ON/OFF        | 자식 JSON 결과와 도구 사용 내역을 수집                                                        |

`Use Question from Chat` ON이면 부모 질문, 아니면 기존 Custom Input / LLM input 우선순위를 사용한다.

Return Direct ON이면 자식 답변 이후 부모 모델이 답변을 다시 작성하지 않는다. 부모의 프롬프트·페르소나·기여도 마크업 지시를 자식이 자동 상속하는 것은 아니다. 예제 자식 프롬프트에는 TOTAL_CONTRIBUTION / CHAT_TITLE 지시가 없었다. 따라서 직접 반환을 사용하는 실제 구성에서는 서비스에 필요한 최종 출력 형식과 후속 메타데이터 처리를 별도로 검증한다. 부모의 최종 합성이 필요하면 OFF로 설정한다.

### 자식 도구와 부모 Vora 노드의 Return Direct 조합

각 옵션은 자신을 직접 호출하는 Agent의 추가 추론 여부를 제어한다. 아래는 해당 도구를 단독 호출하고 정상 반환한 경우의 경로이며, Return Direct를 켠다고 LLM의 최초 도구 선택 호출까지 없어지는 것은 아니다.

| 자식 내부 도구 | 부모 Vora 노드 | 도구 실행 후 답변 경로                                                                      |
| -------------- | -------------- | ------------------------------------------------------------------------------------------- |
| ON             | ON             | 자식 도구 반환값 → 자식 실행 종료 → 부모 실행 종료. 두 LLM 모두 결과를 추가로 정리하지 않음 |
| OFF            | ON             | 자식 LLM이 결과를 정리하고 필요하면 도구를 더 호출 → 자식 최종 답변을 부모가 직접 반환      |
| ON             | OFF            | 자식 도구 반환값으로 자식 실행 종료 → 부모 LLM이 결과를 받아 최종 답변 구성                 |
| OFF            | OFF            | 자식 LLM이 결과를 정리 → 부모 LLM도 결과를 받아 최종 답변 구성                              |

두 단계 모두 ON은 완성된 Markdown·카드·링크처럼 그대로 보여줄 결과를 반환하는 도구에 적합하다. 검색 목록·원시 JSON처럼 해석·비교·종합이 필요한 결과는 자식 도구 OFF + Vora 노드 ON으로 자식이 답변을 완성하게 할 수 있다. 부모에서 여러 허브·개인 자료실 결과를 합쳐야 하면 Vora 노드 OFF를 사용한다. 도구가 반환하는 실제 형식을 확인한 뒤 개별 도구의 설정을 정하며 모든 무료 도구를 일괄 ON으로 바꾸지 않는다.

Return Direct ON은 Custom Tool 함수 내부 처리를 중단하지 않는다. 해당 함수가 결과를 반환한 뒤 Agent의 추가 추론을 생략한다. 일반 Custom Tool 결과가 실행 종료 때 한 번에 반환되면 SSE로 전달되더라도 결과 한 덩어리이며, 이 설정만으로 도구 내부의 처리 과정이 토큰 단위로 스트리밍되지는 않는다. QUOTA_EXHAUSTED 같은 제어 문자열도 LLM이 자연어로 바꾸지 않은 채 상위로 전달될 수 있으므로 VORA의 기존 후처리를 함께 검증한다.

현재 공통 AgentExecutor는 한 번에 선택된 actions를 Promise.all로 실행한 뒤 마지막 action의 returnDirect로 종료 여부를 판단한다. JSON 최종 output은 마지막 observation이고, SSE의 직접 반환 경로는 실행 기록에 있는 직접 반환 도구들의 결과를 전송할 수 있다. 따라서 여러 도구에 ON을 주는 것이 모든 결과의 자동 종합이나 JSON/SSE의 동일한 표현을 보장하지 않는다. Web/Worker 양쪽에서 이 구현이 동일함을 확인했다. 신규 Vora 노드도 부모가 여러 도구를 함께 호출하는 조합을 별도 검증하며, 기존 공통 실행기의 다중 action 의미를 이 작업에서 임의로 바꾸지 않는다.

통신은 기존 `secureFetch`와 URL·UUID·credential 검증을 유지한다. 같은 Chatflow를 직접 다시 호출하는 설정을 거부한다. 요청 헤더 `flowise-tool: true`를 유지하고, 자식 SSE가 필요한 경우에만 `flowise-tool-stream: true`를 추가한다.

### 단일 실행 원칙

현재 보강 노드는 무토큰 응답이나 초기 스트림 실패에서 자식 prediction을 다시 호출할 수 있다. 신규 노드는 **전송한 prediction을 자동으로 두 번 실행하지 않는다**.

-   SSE 요청에 JSON이 반환되면 그 응답 자체를 파싱한다. 두 번째 HTTP 요청을 보내지 않는다.
-   HTTP 오류, error/abort 프레임, 불완전 EOF를 정상 성공으로 바꾸지 않는다.
-   이미 받은 답변 토큰을 다시 일괄 출력하지 않는다.
-   실제로 실행된 자식 도구 내역은 실패 경로에서도 보존한다.
-   자식의 end 프레임이 부모의 전체 스트림을 직접 종료하지 않는다. 부모 종료·저장은 기존 부모 실행 경로가 담당한다.
-   자식 metadata의 chatId나 messageId로 VORA 대화 ID 또는 부모 응답 ID를 덮어쓰지 않는다.
-   신규 호출에서 반복 재시도로 정확히 한 번 실행을 보장한다고 주장하지 않는다. 이 설계가 제거하는 것은 노드 내부의 자동 두 번째 prediction 호출이다.

SSE 파서는 UTF-8 청크 분할, LF/CRLF, 프레임 분할, 마지막 프레임, 정상 JSON 응답을 처리한다. `usedTools`는 현재 자식 생산자의 최종·누적 스냅샷 계약에 맞춰 처리하며 프레임마다 무조건 concat하지 않는다. 같은 이름의 실제 서로 다른 도구 호출을 이름 기준으로 제거하지 않는다.

현재 MAIN ToolAgent 경로는 부모 취소 signal의 도구 전달이 완전하지 않다. 신규 노드가 받은 취소 신호는 HTTP 요청에 연결하되, 서버의 자식 작업까지 중단되는지 확인하기 전에는 종단 간 취소를 보장했다고 보고하지 않는다. 공통 취소 체계 전체 개편은 별도 범위이다.

## 8. 공개 도구 사용 목록과 내부 실행 기록

예상 외부 결과:

```text
내부 실행: vora_tool_search_hub → search_main → search_wiki
공개 목록: search_main, search_wiki
```

구현 원칙:

1. 신규 도구 인스턴스에 private Symbol 등의 식별 표식을 부여한다. Tool Name 문자열, 이름 prefix, 다른 도구와의 이름 중복으로 숨김 여부를 판정하지 않는다.
2. 공통 AgentExecutor는 실제 도구 호출·결과·오류 기록을 그대로 유지한다. 모델의 scratchpad와 추적에 필요한 tool call/result 대응도 유지한다.
3. 부모 결과를 만들 때 공개 `usedTools`만 별도로 투영하여 Vora 중계 호출 항목을 제외한다. 숨김 판정은 성공·오류·입력 파싱 실패에도 동일해야 한다.
4. `withDirectToolReturn`에는 필요한 내부 실행 기록을 유지한다. 공개 목록에서 중계 항목을 제거했다고 답변 전달용 내부 기록까지 제거하면 안 된다.
5. 자식 usedTools는 이름, 입력, 출력, 오류와 호출 순서를 보존한다. 내부 결과가 부모 답변 토큰으로 다시 출력되지 않도록 기존 direct-return 중복 방지 계약을 유지한다.
6. SSE, JSON, 저장된 부모 응답에 같은 공개 목록을 사용한다. 자식에서 도구를 쓰지 않았으면 중계 도구를 대신 표시하지 않는다.
7. 원본 Chatflow Tool과 일반 Custom Tool의 표시 규칙은 변경하지 않는다.

VORA에는 `usedTools`가 비었을 때 `agentReasoning[].usedTools`로 복원하는 경로가 있다. 현재 대상 MAIN ToolAgent의 결과뿐 아니라 자식 무도구·오류 사례에서 중계 이름이 이 경로로 되살아나지 않는지 검사한다. 외부로 직렬화하는 reasoning 도구 목록이 있는 생산자에서는 같은 호출 식별 정보로 투영해야 한다. 내부 callback trace를 통째로 지우거나 VORA에 이름 기반 필터를 하드코딩하지 않는다.

우선 검증 대상은 제공된 MAIN의 ToolAgent와 무료 도구 자식 Chatflow이다. AgentFlow를 부모로 사용하는 등 별도 실행기가 필요한 조합은 동일한 공개 목록 계약이 검증된 범위만 지원 완료로 보고한다.

## 9. 세션·Upstash 계약

-   기본: 부모 chatId=A/sessionId=A, 자식 chatId=B/sessionId=A.
-   같은 Upstash + 같은 sessionId이면 실제 같은 Redis 키의 이력을 읽고 쓴다. chatId는 스트리밍 구분 외에 Flowise 기록에도 사용되므로 순수 통신 ID라고만 설명하지 않는다.
-   Start new session ON이면 호출별 새 sessionId를 생성한다. 명시적인 자식 sessionId override가 있으면 기존 노드 규칙처럼 그것을 우선한다.
-   user_id는 새 세션 여부와 무관하게 같은 현재 부모 사용자이다.
-   부모와 자식 ToolAgent가 각각 대화를 저장하면 한 번의 사용자 턴에 두 실행의 기록이 들어갈 수 있다. 이를 이번 기능이 자동으로 없애지는 않는다.
-   테스트는 정상적인 부모·자식 저장과 불필요한 재호출로 생긴 추가 저장을 구분한다. 메모리의 읽기 전용화·기록 소유자 변경은 별도 설계 대상이다.

## 10. 원본 Chatflow Tool 복구

복구 대상은 공식 ChatflowTool 노드 구현이다. 검토한 원본:

-   파일: `packages/components/nodes/tools/ChatflowTool/ChatflowTool.ts`
-   파일의 공식 최종 변경 commit: `3f257bdc8196082a178da7134a075824401b13b9`
-   Git blob: `a2ae7cc8172e70c6edf644be749ee9d2d1c3ffa4`
-   노드 이름·type: `ChatflowTool`, version: `5.1`
-   아이콘: 기존 `chatflowTool.svg`

이 고정본과 비교하여 복구하며, 구현 시점의 움직이는 upstream HEAD를 무조건 가져오지 않는다. 공통 AgentExecutor, direct-return, Web/Worker의 SSE·Queue 보강 전체를 원복하지 않는다. 신규 Vora 노드에 필요한 공통 기반을 유지한다.

저장된 기존 노드의 name/type/ID는 바꾸지 않는다. 따라서 기존 `ChatflowTool`은 원본 노드로 실행된다. 신규 기능이 필요한 캔버스는 Vora 노드를 명시적으로 추가하여 연결한다.

## 11. 변경 파일과 저장소별 범위

아래 경로는 두 Flowise 저장소의 동일 상대 경로를 뜻한다.

| 파일                                                                        | 계획                                                      |
| --------------------------------------------------------------------------- | --------------------------------------------------------- |
| `packages/components/nodes/tools/VoraChatflowTool/VoraChatflowTool.ts`      | 신규 노드, 요청 user_id / tool_usage 취득, 호출·응답 처리 |
| `packages/components/nodes/tools/VoraChatflowTool/voraRouter.png`           | VoraRouter2 아이콘과 동일 자산                            |
| 신규 노드 인접 helper/test                                                  | 요청 병합, SSE 응답, 동시 호출 테스트를 역할별 분리       |
| `packages/components/nodes/tools/ChatflowTool/ChatflowTool.ts`              | 고정된 공식 원본 복구                                     |
| `packages/components/src/agents.ts`                                         | 내부 기록을 유지한 공개 usedTools 투영                    |
| `packages/components/src/Interface.ts`                                      | 필요한 선택 속성·호출 컨텍스트 타입만 추가                |
| 공통 private metadata helper                                                | 신규 중계 도구 식별, 공개 목록 투영에 필요한 내부 정보    |
| `packages/components/src/directToolReturn.test.ts` 및 Agent 스트리밍 테스트 | 공개 목록 필터 후에도 직접 반환 정상 동작 검증            |
| `packages/server/src/NodesPool.ts` 및 테스트                                | 신규 노드 등록, 공유 credential 아이콘 부작용 방지        |

`directToolReturn.ts`의 기존 동작은 우선 유지한다. 공개 목록 필터를 이유로 해당 내부 계약을 바꾸지 않는다.

서버의 기존 override 변수 적용 경로를 재사용하므로 `buildChatflow.ts`에 부모 override 전체 전달 기능을 새로 넣지 않는다. UI는 기존 노드 메타데이터 기반 UI를 재사용한다. `dist/`, `build/`는 직접 수정하지 않는다.

VORA 서비스의 user_id 생성·toolEnabled 전송·기존 과금 코드 변경은 기본 범위가 아니다. 실제 통합 테스트에서 공개 목록의 누락·복원 문제가 확인된 경우에만 해당 경로에 필요한 최소 변경을 별도로 명시한다.

## 12. 워크플로우와 프롬프트 전환

### 워크플로우

이 단계는 아직 수행하지 않았다. 예제는 구조 설명용이며 아래 분리 작업을 대신 완료한 것으로 취급하지 않는다.

1. 실제 도구 함수·스키마를 기준으로 일반 무료 검색·조회 도구만 분리 목록에 확정한다. 확인된 tool_usage 외에 추가 서버 변수 의존성이 있는지도 검사한다.
2. 개인 자료실·캘린더·문서 편집기·기존 유료 도구는 메인에 남긴다.
3. 자식 워크플로우를 만들고 무료 도구를 기본 enabled로 연결한다.
4. 부모와 자식의 API Override / user_id·tool_usage 허용, credential, Upstash 설정을 검증한다.
5. 메인에 Vora Chatflow Tool을 추가하고 옮긴 도구의 직접 연결을 제거한다.
6. 메인에 남는 도구의 노드 ID를 유지한다. 삭제한 무료 도구의 ID를 다른 도구에 재사용하지 않는다. 자식의 노드 ID는 자식 워크플로우 기준으로 관리하며 부모 ID에 맞추거나 부모 설정을 자동 복사하지 않는다.

메인에 없는 ID의 `toolEnabled`가 남아 있는 것만으로 오류가 발생하지 않는 것은 두 저장소의 실제 override 처리 함수로 확인했다. 이 설정 맵 자체는 LLM 입력 토큰에 포함되지 않는다. 다만 ID를 재사용하면 기존 설정이 다른 도구에 적용될 수 있다.

### 프롬프트

운영 VORA DB의 최신 published MAIN 본문을 2026-10-06 읽기 전용으로 확인했다. 개별 도구 활성화 목록은 없고, 다음 일반 지침이 존재한다.

-   base v16 §7.15: 현재 주입된 도구를 전체 보유 도구로 보는 문구.
-   base v16 §4.1: `current_date_time` 직접 호출 지시.
-   policy v9: 도구 부재 시 결과를 지어내지 않고 구매·활성화·친구 AI를 안내하는 지침.

새 구조에서는 “메인에 제공된 호출 도구를 통해 사용할 수 있는 무료 검색·조회 기능”을 짧게 설명한다. 하위 도구 이름이 메인에 없다는 이유만으로 기능이 없다고 결론 내리지 않도록 안내한다. 실제로 옮기는 직접 호출 지시만 허브 경유에 맞춘다.

자식의 상세 도구 스키마·전체 목록을 메인 프롬프트에 다시 붙이지 않는다. 개인정보·자료실·과금 등 기존 정책 전체를 임의로 재작성하지 않는다. 운영 프롬프트 게시 변경은 노드 코드 구현과 별도 변경 항목으로 검토·검증한다.

예제의 12,743자 프롬프트도 최종 자식 프롬프트로 고정하지 않는다. 자식에는 확정된 무료 도구 범위, 결과 근거, 소진·실패 처리, 필요한 답변 형식을 내장한다. API override로 부모의 대형 systemMessage를 자동 복제하지 않는다. 실제 모델·도구·이력이 확정되기 전에는 토큰 절감률을 수치로 약속하지 않는다.

메인에서 N개 도구를 옮기고 M개 호출 허브를 추가하면 저장된 도구 연결 수는 80−N+M개가 된다. 이는 구조상 개수 계산이며 요청마다 활성화된 실제 모델 도구 수나 토큰 감소율과 같지는 않다.

## 13. 검증 계획과 합격 조건

| 구분                | 핵심 검증                                                                                                   |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| 사용자 상속         | 요청 user_id가 워크스페이스 기본값보다 우선하고 자식 도구가 그 값을 실제 수신                               |
| 병합 우선순위       | 로컬 Override Config의 다른 user_id, LLM 인자, 질문 속 ID로 부모 값을 바꿀 수 없음                          |
| 허용 설정           | 부모 override OFF / user_id 미허용이면 호출 전 설정 오류; 자식 OFF / 미허용은 수신 검증 실패로 전환 불가    |
| 누락 처리           | user_id 누락·빈값·잘못된 타입에서 자식 HTTP 호출 0회; 허브를 쓰지 않은 일반 질의는 계속 가능                |
| 사용자 격리         | 사용자 A/B 동시 호출에서 상대 user_id·sessionId·결과가 섞이지 않음                                          |
| 무료 도구 한도      | tool_usage의 해당 코드가 0이면 실제 외부 API 호출 없이 QUOTA_EXHAUSTED 반환; 양수/-1 통과                   |
| 잔여량 상속         | 현재 부모 JSON 값 우선, 다른 사용자·고정값과 혼합 없음, 자식 허용 OFF로 검사가 생략되지 않는지 확인         |
| 전체 맵 전달        | 여러 도구 값이 든 JSON 문자열을 그대로 전달하고 각 도구가 자기 TOOL_CODE만 조회                             |
| 잔여량 누락         | 부모 누락 시 빈 문자열로 고정값 상속 방지, 기존 값 없음 정책 유지; 정상 요청의 의도치 않은 누락은 전환 실패 |
| 소진 내역           | 자식 usedTools의 QUOTA_EXHAUSTED가 부모에 보존되고 VORA가 성공 실행으로 복원·차감하지 않음                  |
| 세션                | 기본 부모 sessionId 유지, 호출별 chatId 분리, 새 세션 옵션·명시 sessionId 우선순위                          |
| 활성화              | Vora Tool Enabled false이면 모델 bindTools에서 제외; 무료 자식 도구는 기본 enabled                          |
| 기존 override       | 부모에 없는 customTool ID가 있어도 오류나 신규 노드 비활성 오판이 없음                                      |
| SSE                 | 한국어 UTF-8 청크 분할, LF/CRLF, end/error/abort, 정상·불완전 EOF                                           |
| 단일 요청           | JSON 응답, 무토큰 완료, 초기·중간 오류에도 같은 도구 호출당 prediction 재전송 없음                          |
| 반환 모드           | Return Direct ON의 실시간 전달과 OFF의 부모 합성이 각각 정상                                                |
| 중첩 직접 반환      | 자식 도구/Vora 노드의 ON·OFF 네 조합, 원시 JSON·완성 Markdown·소진 문자열의 전달 결과 확인                  |
| 여러 도구 직접 반환 | 부모·자식의 다중 action에서 마지막 action 종료 판정, SSE/JSON 결과 차이와 중복 출력 여부 확인               |
| 도구 목록           | SSE/JSON/저장 결과에서 자식 도구 보존, Vora 중계 항목 제거, 다른 부모 도구 유지                             |
| 특수 목록           | 자식 무도구·오류·동일 이름 반복 호출·reasoning 폴백에서 중계 항목 재등장 없음                               |
| 직접 반환           | 내부 receipt 보존, 답변 누락·이중 출력 없음, HWP 등 기존 직접 반환 회귀 없음                                |
| 원본 복구           | ChatflowTool 파일이 고정 원본과 일치하고 기존 저장 타입으로 실행됨                                          |
| UI                  | 두 노드 검색·배치·연결·저장·재열기, VoraRouter2와 동일 아이콘, credential 아이콘 유지                       |
| 자식 비종속         | 예제 ID·도구 수에 의존하지 않고 서로 다른 두 테스트 자식을 각각 선택하여 호출                               |
| 동일 도구·다른 ID   | 같은 TOOL_CODE의 도구가 부모·자식에서 다른 node ID여도 같은 잔여량 항목을 조회                              |
| 예제 ID 중복        | customTool_11/16이 부모·자식에서 다른 도구여도 부모 toolEnabled가 자식에 잘못 적용되지 않음                 |
| Web/Worker          | 신규 노드·핵심 helper·타입 동등성, 동기 실행과 Queue 실행 모두 검증                                         |
| 실제 연동           | 격리된 테스트 사용자·세션으로 VORA → 부모 → 자식 → 무료 도구 직접 호출                                      |
| 토큰                | 같은 입력·이력·모델에서 메인 최종 provider tools 목록과 실제 usage 비교                                     |
| 직접 반환 형식      | Return Direct ON에서 자식 답변의 표시·기여도·후속 메타데이터 처리, OFF에서 부모 최종 합성 확인              |

단위 테스트는 실제 응답·정책 경계를 검증하는 경우에 집중한다. UI 라벨만 복제하는 테스트를 늘리지 않는다. 관련 components/server 테스트와 빌드 후 각 저장소의 필요한 루트 검증을 실행한다. 신규 helper를 테스트하기 위한 실제 provider 과금 호출은 단위 테스트에서 사용하지 않는다.

실제 연동 검증은 별도로 수행한다. mock 테스트 성공만으로 운영 user_id 수신·토큰 절감·사용 목록 표시가 확인되었다고 보고하지 않는다.

자식 생성 전에는 고정 응답을 주는 테스트 endpoint와 작은 격리 fixture로 요청·SSE·도구 목록 계약을 검증한다. 예제의 25개 실제 도구를 일괄 실행하는 것으로 단위 검증을 대체하지 않는다. 자식 생성 후에 실제 무료 도구를 선정해 API 경로로 직접 호출한다.

### Queue와 취소의 운영 검증

현재 Queue 모드에서는 자식 prediction도 같은 prediction queue에 들어간다. 부모 작업이 자식을 기다리며 슬롯을 차지하므로, 부모 작업으로 모든 슬롯이 찬 상황에서는 자식 처리가 대기할 수 있다. 평균적인 한 번의 성공만으로 이 경로를 검증하지 않는다.

실제 동시성 설정과 부모 부하로 포화 테스트를 수행한다. 포화 시 처리가 진행되지 않으면 부모 admission 제한 또는 자식 처리 용량 분리 방안을 정한 뒤 전환한다. 단순히 concurrency 숫자를 늘리면 항상 해결된다고 가정하거나 운영 환경값을 이 설계 단계에서 변경하지 않는다.

부모 중지·연결 종료 시 자식 연결 및 실제 작업의 종료 여부도 측정한다. 현재의 별도 자식 chatId와 부모 취소 범위가 자동으로 같은 것으로 간주하지 않는다.

## 14. 단계별 구현·전환·되돌리기

### A. 노드 기능 구현 — 운영 자식 생성과 독립적으로 수행

1. 두 저장소의 기준 상태와 원본 ChatflowTool을 고정하고 분리된 작업 브랜치를 준비한다.
2. 신규 Vora 노드와 요청 user_id / tool_usage 병합·기본 JSON 호출을 구현하고 단위 검증한다.
3. 단일 요청 SSE와 JSON 응답 처리, 자식 도구 수집을 구현한다.
4. 공통 실행기의 공개 도구 목록 투영과 direct-return 회귀 검증을 완료한다.
5. 원본 ChatflowTool을 복구하고 노드 등록·아이콘·UI를 검증한다.
6. 두 저장소의 관련 테스트·빌드를 통과시킨다. 서로 다른 서버 파일을 일괄 동기화하지 않는다.
7. 테스트 endpoint와 격리 fixture로 노드 계약을 검증한다. 운영 자식 생성 전이면 결과를 “노드 구현·fixture 검증 완료”로만 보고한다.

### B. 실제 자식 생성 후 통합 검증·전환

1. 사용자가 최종 무료 도구 범위를 정하고 자식을 생성하면 실제 연결·함수·API Override를 확인한다.
2. 격리된 부모·자식 워크플로우로 VORA 연동, 공유 Upstash, Queue 동시성, 취소, 토큰을 검증한다.
3. Web과 Worker 모두 신규 타입을 지원하는 것을 확인한 뒤 운영 메인에 신규 노드를 연결한다. 한쪽만 배포된 상태에서 신규 노드를 활성화하지 않는다.
4. 운영 메인에서 분리 대상 직접 연결을 제거하고 필요한 최소 프롬프트 변경을 적용·검증한다.

되돌리기 준비물은 변경 전 부모 워크플로우 export, 추후 생성·검증한 자식의 export, 각 API Override 설정, 관련 프롬프트 게시 버전, 두 코드 기준 SHA이다. API credential은 설계서나 export 보조 문서에 복사하지 않는다.

코드를 이전 버전으로 되돌리기 전에 신규 노드를 참조하는 운영 그래프부터 호환되는 이전 구성으로 되돌려야 한다. 새 노드 타입을 모르는 Worker가 새 그래프를 실행하는 상태를 만들지 않는다. Redis 대화 기록은 롤백 과정에서 임의 삭제하지 않는다.

## 15. 완료 기준과 남은 확인

**설계 완료:** 신규 노드의 계약과 구현 순서는 확정한다. 운영 자식의 도구 목록·Chatflow ID·모델·최종 응답 프롬프트는 사용자가 아직 확정·생성하지 않았으며 이 문서에서 임의로 확정하지 않는다.

**노드 기능 완료:** A단계의 코드·테스트·등록·아이콘·원본 복구 검증을 통과한 상태. 이를 운영 도구 분리나 실제 토큰 절감 완료로 보고하지 않는다.

**운영 전환 완료:** B단계에서 실제 자식을 대상으로 아래 조건을 확인한 상태.

완료 기준은 부모의 실제 override 사용자·잔여량 값이 자식 도구에서 그대로 사용되고, 무료 도구의 기존 한도 검사가 유지되며, 일반 질문의 메인 도구 스키마가 줄고, 자식 도구의 공개 내역만 부모에 표시되고, 기존 원본 노드가 독립적으로 동작하는 것이다.

확정된 설계와 구분할 실행 전 확인 항목:

-   이동할 실제 무료 도구 함수가 user_id / tool_usage 외 서버 변수에 의존하는지.
-   실제 부모·자식의 API Override 허용 상태와 credential 연결.
-   공유 Upstash의 정상 부모·자식 기록량, 재호출 제거 후의 변화.
-   실제 Worker 용량에서의 중첩 Queue 진행성 및 취소 전파 범위.
-   부모가 자식 허브를 정확히 선택하는지와 최종 provider usage.

운영 DB의 MAIN base + policy 원문은 46,939자였으며 이는 토큰 수가 아니다. 노드 분리로 줄이는 도구 스키마와 별개의 기본 프롬프트 비용이다. 이력·기본 정책 전체의 압축은 이번 신규 노드 구현 범위에 포함하지 않는다.
