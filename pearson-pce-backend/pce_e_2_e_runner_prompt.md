# Prompt for AI Implementation: Java E2E Runner for Pearson Career Explorer

## Goal
Implement a **Java-based E2E test runner** that replicates and extends the functionality of the existing `studentJourney.ts` end-to-end test. The runner must be a standalone application with a `main()` method, runnable via both **Gradle** and **Maven**. It validates the Pearson Career Explorer backend API against the v0.4 specification.

---

## Requirements

### General
- Language: Java 21+
- Build tools: Gradle & Maven
- Use **java.net.http.HttpClient** for HTTP requests.
- Use **Jackson** for JSON serialization/deserialization.
- Must run as a standalone app (`main()`), independent from unit tests.

### Structure
Organize code into clear OOP packages:

```
com/pce/e2e/
│
├── StudentJourneyRunner.java       // Main entrypoint
│
├── api/
│   └── ApiClient.java              // Encapsulates REST calls
│
├── flow/
│   ├── FlowRunner.java             // Implements Turn-by-Turn and Batch flows
│   ├── ResultValidator.java        // Compares results (flow equivalence, preview consistency)
│   └── NegativeTests.java          // Covers 409 conflict, old API format rejection
│
├── generator/
│   └── ResponseGenerator.java      // Deterministic answer generator (LCG-based)
│
├── model/
│   ├── Student.java                // DTO for /api/student
│   ├── Assessment.java             // DTO for /api/student-assessment
│   ├── Question.java               // DTO for ui-questions.json
│   ├── Response.java               // DTO for /api/question-response & batch
│   ├── CareerMatch.java            // DTO for /api/career-match/{id}
│   ├── PreviewMatch.java           // DTO for /api/match/preview
│   ├── CareerPreference.java       // DTO for career preferences
│   └── CareerDetail.java           // DTO for career details
│
└── util/
    └── JsonUtils.java              // Helper for loading/parsing ui-questions.json
```

---

## Flows to Implement

### 1. Turn-by-Turn Flow
- `POST /api/student`
- `POST /api/student-assessment`
- For each question from `ui-questions.json`:
  - Generate deterministic response with `ResponseGenerator`.
  - `POST /api/question-response`.
  - Periodically: `PUT /api/game-save/{assessmentId}`.
  - After each turn: call `GET /api/match/preview` for progressive monitoring.
- Complete with `POST /api/student-assessment/{id}/complete`.
- Fetch results with `GET /api/career-match/{id}`.

### 2. Batch Flow
- `POST /api/student`
- `POST /api/student-assessment`
- Generate all responses with `ResponseGenerator`.
- `POST /api/game-batch-save`.
- `POST /api/student-assessment/{id}/complete`.
- Fetch results with `GET /api/career-match/{id}`.

### 3. Career Preferences Testing
- Test initial empty preferences state
- Save career preferences using top matches
- Retrieve and verify saved preferences
- Test replace-on-save semantics (new preferences replace old ones)
- Test clearing preferences with empty array
- Validation testing: reject duplicate ranks, non-contiguous ranks, invalid career IDs

### 4. Validation & Consistency Tests
- **Flow Equivalence**: Compare Turn-by-Turn vs Batch results → must be identical
- **Preview Consistency**: Compare Final Results vs Preview Results → identical within tolerance `1e-6`
- **Progressive Preview**: Monitor preview changes during assessment progression

### 5. Negative Tests
- **409 Conflict**: try to start a second assessment for the same student; expect 409
- **OLD API FORMAT REJECTION**: submit payload with `studentId` field (old format); expect 400


---

## Response Generation Logic

**IMPORTANT**: Responses must be generated deterministically with business-rule-specific logic:

### Question Type Handling
Based on `questionGroup` field from ui-questions.json:

- **"Ranking"**: Values `1..maxValue` (standard career attribute ranking)
- **"Elimination"**: Only `0` (eliminate) or `1` (keep) regardless of maxValue
- **"Courses of Study"**: Only `-1` (aversion) or `0` (indifferent) regardless of maxValue

### Deterministic Algorithm
Use Linear Congruential Generator (LCG) with question ID as seed:
```java
// Simple LCG implementation matching TypeScript version
int seededInt(int seed, int mod) {
    long x = (seed ^ 0x9e3779b1L) & 0xFFFFFFFFL; // mix the seed
    x = (1103515245L * x + 12345L) & 0xFFFFFFFFL;
    return mod > 0 ? (int)(x % mod) : 0;
}

// Example usage for Ranking questions:
int valueOne = seededInt(questionId, maxValue) + 1;
```

## Additional Requirements
- Logs should be plain text (no colors).
- The runner should exit with non-zero status if validation fails.
- No unit-test integration: this is a **standalone verification tool**.
- Load questions from `e2e-test/ui-questions.json` in project root.
- Default base URL: `http://localhost:8080`

---

## Deliverables
- Full Java implementation of described classes.
- Gradle support (`./gradlew run`).
- Maven support (`mvn compile exec:java`).
- Instructions in README for running against a local PCE backend.

