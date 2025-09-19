# Partial Career Match Implementation Plan

## Задача

**Цель**: Реализовать read-only API endpoint для превью карьерных совпадений на основе текущих ответов студента без финализации assessment'а.

**Контекст**: Используется в "Choose Your Future" turns для показа топ-3 карьер в выбранном кластере на основе ответов, данных до этого момента.

**Ключевое требование**: Использовать ту же логику расчета что в `ScoringService.calculateCompleteScores()`, но без записи в БД.

## API Контракт

### Endpoint
```
GET /api/match/preview
```

### Параметры
- `assessmentId` (required, Long) - ID assessment'а для которого считаем совпадения
- `clusterCode` (optional, String) - фильтр по коду кластера карьер (например, "STEM")  
- `topN` (optional, Integer, min=1, max=50) - лимит результатов (default: все)

### Response Structure
```json
{
  "assessmentId": 2001,
  "clusterCode": "STEM",
  "results": [
    { "careerId": 501, "careerName": "Civil Engineer", "matchScore": 0.864 },
    { "careerId": 502, "careerName": "Software Engineer", "matchScore": 0.721 },
    { "careerId": 503, "careerName": "Data Scientist", "matchScore": 0.689 }
  ]
}
```

### Error Responses
- `400` - validation error (неверные параметры)
- `401` - authentication required  
- `403` - access forbidden (не свой assessment для студентов)
- `404` - assessment not found

## Архитектурные решения

### 1. Новые файлы для создания

#### DTO классы
- **`src/main/java/com/pearson/pce/api/dto/MatchPreviewItem.java`**
  ```java
  public record MatchPreviewItem(
      Long careerId,
      String careerName, 
      BigDecimal matchScore
  )
  ```

- **`src/main/java/com/pearson/pce/api/dto/MatchPreviewResponse.java`**
  ```java
  public record MatchPreviewResponse(
      Long assessmentId,
      String clusterCode,
      List<MatchPreviewItem> results
  )
  ```

### 2. Файлы для изменения

#### CareerController.java
- **Добавить**: новый endpoint `GET /api/match/preview`
- **Метод**: `getMatchPreview(Long assessmentId, String clusterCode, Integer topN)`
- **Validation**: `@RequestParam` с `@Min(1) @Max(50)` для topN
- **Security**: `@PreAuthorize("@security.canAccessAnyResource()")`
- **Swagger**: полная OpenAPI документация с examples

#### CareerService.java  
- **Добавить**: метод `previewMatches(Long assessmentId, String clusterCode, Integer topN)`
- **Реализация**: единый SQL запрос с CTEs
- **Security**: проверка ownership для студентов
- **Validation**: проверка существования assessment'а и clusterCode

## Техническая реализация

### SQL Стратегия

**Цель**: Объединить логику из `ScoringService.aggregateStudentAttributeScores()` и `ScoringService.calculateCareerMatches()` в один запрос.

#### Реализованный SQL (упрощенный подход без CTEs):

```sql
-- Основной запрос с подзапросами вместо CTEs (избегаем синтаксических проблем PostgreSQL)
SELECT 
    ca.career_id,
    c.name as career_name,
    SUM(
        (total_scores.total_value / total_scores.max_possible_score) * 
        caz.z_score_value * 
        total_scores.scoring_weight
    ) AS match_score
FROM (
    -- Подзапрос 1: Live Student Attribute Scores (аналог aggregateStudentAttributeScores)
    SELECT 
        ? as student_assessment_id,
        attr_scores.attribute_id,
        SUM(attr_scores.value) as total_value,
        SUM(attr_scores.max_value) as max_possible_score,
        MIN(attr_scores.scoring_weight) as scoring_weight,
        MIN(attr_scores.question_group) as question_group
    FROM (
        -- UNION ALL: attribute_one responses
        SELECT 
            qr.student_assessment_id,
            qr.attribute_one_id as attribute_id,
            qr.value_one as value,
            qt.max_value,
            qt.scoring_weight,
            qt.question_group
        FROM question_response qr
        JOIN question q ON q.id = qr.question_id
        JOIN question_type qt ON qt.id = q.type_id
        WHERE qr.student_assessment_id = ? 
          AND qr.attribute_one_id IS NOT NULL
        
        UNION ALL
        
        -- UNION ALL: attribute_two responses
        SELECT 
            qr.student_assessment_id,
            qr.attribute_two_id as attribute_id,
            qr.value_two as value,
            qt.max_value,
            qt.scoring_weight,
            qt.question_group
        FROM question_response qr
        JOIN question q ON q.id = qr.question_id
        JOIN question_type qt ON qt.id = q.type_id
        WHERE qr.student_assessment_id = ?
          AND qr.attribute_two_id IS NOT NULL
    ) attr_scores
    GROUP BY attr_scores.attribute_id
) total_scores
-- Career matching joins
JOIN attribute a ON a.id = total_scores.attribute_id 
                AND a.exclude_from_matching = FALSE
JOIN career_attribute ca ON ca.attribute_id = total_scores.attribute_id
JOIN career c ON c.id = ca.career_id
JOIN career_attribute_zscore caz ON caz.career_id = ca.career_id 
                                AND caz.attribute_id = total_scores.attribute_id
                                AND caz.question_group = total_scores.question_group
WHERE total_scores.student_assessment_id = ?
  -- Deal-breaker filter: exclude career if it has high requirement (z_score > 1.0) 
  -- for any "Courses of Study" attribute that student strongly dislikes (normalized_value = -1)
  AND NOT EXISTS (
      SELECT 1
      FROM (
          -- Live computation для deal-breaker (дублируем логику агрегации)
          SELECT 
              attr_scores2.attribute_id,
              SUM(attr_scores2.value) / SUM(attr_scores2.max_value) as normalized_value,
              MIN(attr_scores2.question_type_name) as question_type_name
          FROM (
              SELECT 
                  qr2.student_assessment_id,
                  qr2.attribute_one_id as attribute_id,
                  qr2.value_one as value,
                  qt2.max_value,
                  qt2.name as question_type_name
              FROM question_response qr2
              JOIN question q2 ON q2.id = qr2.question_id
              JOIN question_type qt2 ON qt2.id = q2.type_id
              WHERE qr2.student_assessment_id = ? 
                AND qr2.attribute_one_id IS NOT NULL
              
              UNION ALL
              
              SELECT 
                  qr2.student_assessment_id,
                  qr2.attribute_two_id as attribute_id,
                  qr2.value_two as value,
                  qt2.max_value,
                  qt2.name as question_type_name
              FROM question_response qr2
              JOIN question q2 ON q2.id = qr2.question_id
              JOIN question_type qt2 ON qt2.id = q2.type_id
              WHERE qr2.student_assessment_id = ?
                AND qr2.attribute_two_id IS NOT NULL
          ) attr_scores2
          GROUP BY attr_scores2.attribute_id
      ) total_scores2
      JOIN career_attribute_zscore caz2 ON caz2.attribute_id = total_scores2.attribute_id
      WHERE caz2.career_id = ca.career_id
        AND total_scores2.normalized_value = -1
        AND caz2.z_score_value > 1.0
        AND total_scores2.question_type_name = 'Courses of Study'
  )
  -- Опциональный clusterCode фильтр
  AND (? IS NULL OR UPPER(c.career_cluster_code) = UPPER(?))
GROUP BY ca.career_id, c.name
ORDER BY match_score DESC
LIMIT ?  -- topN limit (если указан)
```

**Примечание**: Мы отказались от CTEs из-за синтаксических проблем PostgreSQL с complex nested structures. Вместо этого используем подзапросы, что функционально идентично.

### Логика алгоритма

**Step 1**: Live Student Score Aggregation
- Берем все ответы из `question_response` для данного assessment'а
- Объединяем `attribute_one_id`/`value_one` и `attribute_two_id`/`value_two` через UNION ALL
- Суммируем значения по атрибутам: `total_value` и `normalized_value`
- **Формула**: `normalized_value = SUM(value) / SUM(max_value)`

**Step 2**: Question Group Detection  
- Определяем `question_group` и `scoring_weight` для каждого атрибута
- **Критическое допущение**: каждый атрибут принадлежит только одной `question_group` в рамках assessment'а

**Step 3**: Career Match Scoring
- Применяем формулу: `match_score = Σ(normalized_value × z_score_value × scoring_weight)`
- Используем `career_attribute_zscore` с группировкой по `question_group`
- Исключаем атрибуты с `exclude_from_matching = TRUE`

**Step 4**: Deal-breaker Filter
- Исключаем карьеры где `student.normalized_value = -1` И `career.z_score_value > 1.0`
- Применяется для `question_group = 'Elimination'` (или `question_type.name = 'Courses of Study'`)
- **Важно**: фильтр применяется ко ВСЕМ атрибутам, включая excluded from matching

**Step 5**: Optional Filtering
- Фильтрация по `clusterCode` (case-insensitive)
- Лимит `topN` результатов
- Сортировка по `match_score DESC`

## Security & Authorization

### Access Control
- **Студенты**: могут получать preview только своих assessment'ов
- **Учителя/Админы**: могут получать preview любых assessment'ов
- **Проверка ownership**: через `student.login = userDetails.login`

### Security Annotation
```java
@PreAuthorize("@security.canAccessAnyResource()")
```

### Validation Rules
- `assessmentId`: required, должен существовать
- `clusterCode`: optional, должен существовать в `career_cluster.code` если указан
- `topN`: optional, min=1, max=50

## Детальный план изменений файлов

### 1. DTO классы (новые файлы)

**File**: `src/main/java/com/pearson/pce/api/dto/MatchPreviewItem.java`
```java
package com.pearson.pce.api.dto;

import java.math.BigDecimal;
import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "Career match preview item with computed match score")
public record MatchPreviewItem(
    @Schema(description = "Career ID", example = "25")
    Long careerId,
    
    @Schema(description = "Career name", example = "Software Engineer")
    String careerName,
    
    @Schema(description = "Computed match score based on current student responses", example = "0.864")
    BigDecimal matchScore
) {}
```

**File**: `src/main/java/com/pearson/pce/api/dto/MatchPreviewResponse.java`
```java
package com.pearson.pce.api.dto;

import java.util.List;
import io.swagger.v3.oas.annotations.media.Schema;

@Schema(description = "Career match preview response with live computed matches")
public record MatchPreviewResponse(
    @Schema(description = "Assessment ID", example = "2001")
    Long assessmentId,
    
    @Schema(description = "Career cluster code filter applied", example = "STEM")
    String clusterCode,
    
    @Schema(description = "Career matches ordered by score descending")
    List<MatchPreviewItem> results
) {}
```

### 2. CareerController.java (изменения)

**Добавить новый endpoint метод**:
```java
@Operation(
    summary = "Preview career matches for incomplete assessment",
    description = "Returns live career match preview based on current student responses without finalizing the assessment. Uses the same matching algorithm as final scoring but computes results on-demand from saved question responses. Optionally filters by career cluster and limits results. Used during 'Choose Your Future' turns to show top career matches within a selected cluster based on answers given so far. Does not persist any data - read-only preview operation.",
    security = @SecurityRequirement(name = "bearerAuth")
)
@ApiResponse(responseCode = "200", description = "Career match preview computed successfully",
        content = @Content(schema = @Schema(implementation = MatchPreviewResponse.class)))
@CommonErrorResponses.ValidationError
@CommonErrorResponses.AuthForbiddenAndNotFound  
@GetMapping("/match/preview")
@PreAuthorize("@security.canAccessAnyResource()")
public ResponseEntity<MatchPreviewResponse> getMatchPreview(
        @Parameter(description = "Assessment ID", example = "2001", required = true)
        @RequestParam Long assessmentId,
        
        @Parameter(description = "Optional career cluster code filter", example = "STEM")
        @RequestParam(required = false) String clusterCode,
        
        @Parameter(description = "Optional limit for top N matches", example = "10")
        @RequestParam(required = false) @Min(1) @Max(50) Integer topN) {
    
    MatchPreviewResponse response = careerService.previewMatches(assessmentId, clusterCode, topN);
    return ResponseEntity.ok(response);
}
```

**Импорты для добавления**:
```java
import com.pearson.pce.api.dto.MatchPreviewResponse;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Max;
```

### 3. CareerService.java (изменения)

**Добавить новый метод**:
```java
@Transactional(readOnly = true)
@PreAuthorize("@security.canAccessAnyResource()")
public MatchPreviewResponse previewMatches(Long assessmentId, String clusterCode, Integer topN) {
    PceUserDetails userDetails = securityHelper.getCurrentUserDetails();
    
    // 1. Validate assessment exists and check ownership
    validateAssessmentAccess(assessmentId, userDetails);
    
    // 2. Validate clusterCode if provided
    validateClusterCode(clusterCode);
    
    // 3. Validate critical assumption (same as ScoringService)
    validateSingleQuestionGroupPerAttribute(assessmentId);
    
    // 4. Build and execute the complex SQL query
    String sql = buildMatchPreviewQuery(clusterCode, topN);
    Object[] parameters = buildMatchPreviewParameters(assessmentId, clusterCode, topN);
    
    // 5. Execute query and map to DTOs
    Result<Record> result = dslContext.fetch(sql, parameters);
    List<MatchPreviewItem> matches = result.stream()
        .map(r -> new MatchPreviewItem(
            r.get("career_id", Long.class),
            r.get("career_name", String.class), 
            r.get("match_score", BigDecimal.class)
        ))
        .collect(Collectors.toList());
    
    return new MatchPreviewResponse(assessmentId, clusterCode, matches);
}
```

**Вспомогательные методы**:
- `validateAssessmentAccess()` - проверка существования и ownership
- `validateClusterCode()` - проверка существования кластера (если указан)
- `validateSingleQuestionGroupPerAttribute()` - проверка critical assumption (копия из ScoringService)
- `buildMatchPreviewQuery()` - построение SQL с условными частями
- `buildMatchPreviewParameters()` - подготовка параметров для SQL

### 4. SQL Query Implementation

**Сложный запрос с CTEs**:
- **CTE 1**: `student_scores_live` - live агрегация student attribute scores
- **CTE 2**: `attribute_question_groups` - определение question_group для каждого атрибута
- **CTE 3**: `career_matches` - расчет match scores с deal-breaker фильтром
- **Final SELECT**: применение clusterCode фильтра и topN лимита

**Ключевые особенности SQL**:
- Параметризованные условия для clusterCode и topN
- UNION ALL для объединения attribute_one и attribute_two responses
- JOIN с `career_attribute_zscore` на `(career_id, attribute_id, question_group)`
- NOT EXISTS subquery для deal-breaker логики
- Proper ordering и limiting

### 5. Validation Logic

**Assessment Validation**:
- Проверка существования в `student_assessment` 
- Для студентов: проверка `student.login = userDetails.login`
- Проверка что assessment не завершен (опционально)

**Parameter Validation**:
- `clusterCode`: проверка существования в `career_cluster.code` (case-insensitive)
- `topN`: range validation (1-50) через Bean Validation

**Business Logic Validation**:
- Проверка critical assumption: каждый атрибут принадлежит только одной question_group
- Аналогично `ScoringService.validateSingleQuestionGroupPerAttribute()`

## Error Handling

### Custom Exceptions
- `ResourceNotFoundException` - assessment/cluster не найден
- `AccessForbiddenException` - нет доступа к чужому assessment'у  
- `ValidationException` - неверные параметры
- `IllegalStateException` - violation of question group assumption

### Response Codes
- `200` - успешный результат (может быть пустой список)
- `400` - validation error с details
- `403` - access forbidden 
- `404` - assessment не найден

## Performance Considerations

### Query Optimization
- Использование indexed joins на FK relationships
- CTEs для избежания multiple table scans
- Proper WHERE clause ordering для early filtering
- LIMIT применяется на уровне SQL, не в Java

### Memory Management  
- Streaming результатов через jOOQ `.stream()`
- Нет кэширования - каждый запрос live computation
- Ограничение topN для контроля размера результата

### Database Impact
- Read-only операции
- Нет записи в `student_attribute_score` или `career_match`
- Транзакция `@Transactional(readOnly = true)`

## Testing Strategy

### Unit Tests
- Mock DSLContext для изоляции SQL логики
- Тестирование validation методов
- Тестирование security проверок

### Integration Tests  
- Тестирование полного SQL запроса на реальной БД
- Сравнение результатов с `ScoringService` на тех же данных
- Тестирование различных параметров (clusterCode, topN)

### Edge Cases
- Пустые ответы (no question_response records)
- Несуществующий clusterCode
- Assessment без match results
- Various topN values (1, 50, null)

## Implementation Checklist

### Phase 1: Core Implementation
- [ ] Создать MatchPreviewItem.java
- [ ] Создать MatchPreviewResponse.java  
- [ ] Добавить endpoint в CareerController
- [ ] Реализовать previewMatches() в CareerService

### Phase 2: SQL Logic
- [ ] Построить CTE для student_scores_live
- [ ] Построить CTE для attribute_question_groups  
- [ ] Построить CTE для career_matches с deal-breaker filter
- [ ] Добавить clusterCode и topN filtering

### Phase 3: Security & Validation
- [ ] Добавить security annotations
- [ ] Реализовать assessment ownership validation
- [ ] Добавить parameter validation
- [ ] Добавить clusterCode existence check

### Phase 4: Documentation & Error Handling
- [ ] Полная Swagger/OpenAPI документация
- [ ] Proper error responses с @CommonErrorResponses
- [ ] Exception handling для всех edge cases
- [ ] Logging для debugging и monitoring

### Phase 5: Testing & Validation
- [ ] Unit tests для validation logic
- [ ] Integration test с реальными данными
- [ ] Сравнение результатов с ScoringService
- [ ] Performance testing

## Expected Files Modified

### New Files (2):
1. `src/main/java/com/pearson/pce/api/dto/MatchPreviewItem.java`
2. `src/main/java/com/pearson/pce/api/dto/MatchPreviewResponse.java`

### Modified Files (2):
1. `src/main/java/com/pearson/pce/api/CareerController.java` - добавить endpoint
2. `src/main/java/com/pearson/pce/service/CareerService.java` - добавить business logic

### Updated Documentation (1):
1. `documents/srs/Pce Api Spec v.0.3.txt` - ✅ уже обновлен

**Total**: 2 новых файла + 2 изменения + 1 документация = 5 файлов

## Success Criteria

### Functional
- ✅ Endpoint возвращает корректные match scores
- ✅ Результаты идентичны ScoringService при тех же данных  
- ✅ Правильная фильтрация по clusterCode и topN
- ✅ Пустые результаты если нет ответов
- ✅ Deal-breaker логика работает корректно

### Non-Functional
- ✅ Read-only operation (никаких записей в БД)
- ✅ Performance: единый SQL запрос
- ✅ Security: правильные access controls
- ✅ Error handling: meaningful error messages
- ✅ API documentation: полная Swagger spec

### Technical
- ✅ Следует existing code conventions  
- ✅ Proper exception handling
- ✅ Comprehensive logging
- ✅ jOOQ best practices
- ✅ Spring Security integration

## Future Refactoring (Phase 6)

После успешной реализации и тестирования основной функциональности, планируется рефакторинг для устранения дублирования SQL логики между `ScoringService` и `CareerService`.

### Цель Рефакторинга
- **DRY принцип**: Избежать дублирования SQL логики агрегации и scoring'а
- **Единая точка правды**: Изменения в алгоритме применяются везде автоматически  
- **Модульность**: Переиспользуемые SQL building blocks

### Планируемая Архитектура
```java
// Новый utility class
public class MatchingSqlBuilder {
    
    // Агрегация student attribute scores (Step 2 из ScoringService)
    public static String buildStudentScoresLiveCte() { ... }
    
    // Определение question groups для scoring_weight  
    public static String buildAttributeQuestionGroupsCte() { ... }
    
    // Career match scoring с deal-breaker filter (Step 3 из ScoringService)
    public static String buildCareerMatchesCte(String clusterFilter, Integer topNLimit) { ... }
    
    // Полный запрос для preview (read-only)
    public static String buildPreviewQuery(String clusterCode, Integer topN) { ... }
    
    // Полный запрос для final scoring (с INSERT)
    public static String buildFinalScoringQuery() { ... }
}
```

### Использование
```java
// В CareerService.previewMatches():
String sql = MatchingSqlBuilder.buildPreviewQuery(clusterCode, topN);

// В ScoringService.calculateCareerMatches(): 
String sql = MatchingSqlBuilder.buildFinalScoringQuery();
```

### Рефакторинг План
1. **Извлечь SQL builders** из текущей реализации preview
2. **Обновить ScoringService** для использования тех же builders
3. **Проверить идентичность** результатов до и после рефакторинга
4. **Cleanup**: удалить дублирующийся код
5. **validateSingleQuestionGroupPerAttribute()** вынести
### Преимущества
- ✅ Consistent scoring algorithm везде
- ✅ Easier maintenance и bug fixes
- ✅ Better testability SQL логики  
- ✅ Reduced code duplication

**Примечание**: Рефакторинг выполняется только после полного тестирования и валидации основной функциональности.

---

**Этот план обеспечивает**:
- Четкое понимание scope'а и requirements
- Детальную техническую реализацию  
- Пошаговый implementation plan
- Критерии успеха для validation
- План будущих улучшений
- Возможность продолжить в любой новой сессии