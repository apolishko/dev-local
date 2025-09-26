# Partial Career Match Refactoring (Phase 6)

## Overview

This document describes the Phase 6 refactoring of the Partial Career Match feature, which eliminated code duplication between `CareerService.previewMatches()` and `ScoringService.calculateCareerMatches()`.

## Problem Statement

After implementing the partial career match functionality, significant code duplication existed:

### Code Duplication Issues
- **200+ lines of SQL logic** duplicated between preview and final scoring
- **Identical algorithm implementation** in two separate methods
- **Risk of logic divergence** - changes needed to be applied in two places
- **Maintenance burden** - same business rules duplicated

### Specific Duplications
1. **Student Score Aggregation**: UNION ALL logic for attribute_one/attribute_two
2. **Deal-breaker Filter**: Complex NOT EXISTS subquery with Course of Study logic
3. **Validation Logic**: `validateSingleQuestionGroupPerAttribute()` method
4. **Core Matching Algorithm**: Weighted sum formula with z-score calculations

## Refactoring Solution

### Architecture Changes

Created two new utility classes in `src/main/java/com/pearson/pce/service/matching/`:

#### 1. MatchingSqlBuilder.java
**Purpose**: Single source of truth for all SQL generation
**Key Methods**:
- `buildCareerMatchingCore()` - Unified core algorithm with flexibility flags
- `buildDealBreakerFilterSubquery()` - Deal-breaker filter logic
- `buildPreviewQuery()` - Complete preview query
- `buildFinalScoringQuery()` - Complete INSERT query for final scoring

#### 2. MatchingValidationUtils.java
**Purpose**: Shared validation logic
**Key Methods**:
- `validateSingleQuestionGroupPerAttribute()` - Critical assumption validation

### Core Design Pattern

```java
// Single parametrized core method
public static String buildCareerMatchingCore(
    boolean forInsert,           // INSERT vs SELECT format
    boolean includeClusterFilter,// Optional cluster filtering  
    boolean includeTopN          // Optional result limiting
) {
    // Flexible SELECT clause
    String selectClause = forInsert 
        ? "SELECT ?, ca.career_id," 
        : "SELECT ca.career_id, c.name as career_name,";
    
    // Common scoring formula (single source of truth)
    String matchScoreFormula = """
        SUM(
            (total_scores.total_value / total_scores.max_possible_score) * 
            caz.z_score_value * 
            total_scores.scoring_weight
        ) AS match_score
        """;
    
    // Assemble with conditional components
    return selectClause + matchScoreFormula + coreQuery + 
           dealBreakerFilter + clusterFilter + groupOrderClause;
}
```

### Service Layer Integration

#### CareerService Changes
```java
// Before: 130+ lines of duplicated SQL and validation
private String buildMatchPreviewQuery(String clusterCode, Integer topN) { ... }
private void validateSingleQuestionGroupPerAttribute(Long assessmentId) { ... }

// After: Clean delegation to shared utilities
String sql = MatchingSqlBuilder.buildPreviewQuery(clusterCode, topN);
MatchingValidationUtils.validateSingleQuestionGroupPerAttribute(dslContext, assessmentId);
```

#### ScoringService Changes
```java
// Before: 80+ lines of duplicated SQL and validation  
private void calculateCareerMatches(Long assessmentId) { ... }
private void validateSingleQuestionGroupPerAttribute(Long assessmentId) { ... }

// After: Clean delegation to shared utilities
String sql = MatchingSqlBuilder.buildFinalScoringQuery();
MatchingValidationUtils.validateSingleQuestionGroupPerAttribute(dslContext, assessmentId);
```

## Implementation Details

### SQL Generation Strategy

The refactoring uses a **parametrized template approach**:

1. **Common Core**: All business logic in single method
2. **Flexible Output**: `forInsert` flag changes SELECT clause format
3. **Optional Features**: Conditional cluster filter and LIMIT clauses
4. **Parameter Management**: Consistent parameter ordering across all variants

### Key Algorithms Preserved

#### 1. Student Score Aggregation
```sql
-- Identical UNION ALL logic for both preview and final scoring
SELECT ? as student_assessment_id, attr_scores.attribute_id,
       SUM(attr_scores.value) as total_value,
       SUM(attr_scores.max_value) as max_possible_score,
       MIN(attr_scores.scoring_weight) as scoring_weight,
       MIN(attr_scores.question_group) as question_group
FROM (
    SELECT qr.student_assessment_id, qr.attribute_one_id as attribute_id,
           qr.value_one as value, qt.max_value, qt.scoring_weight, qt.question_group
    FROM question_response qr
    JOIN question q ON q.id = qr.question_id
    JOIN question_type qt ON qt.id = q.type_id
    WHERE qr.student_assessment_id = ? AND qr.attribute_one_id IS NOT NULL
    
    UNION ALL
    
    SELECT qr.student_assessment_id, qr.attribute_two_id as attribute_id,
           qr.value_two as value, qt.max_value, qt.scoring_weight, qt.question_group
    FROM question_response qr
    JOIN question q ON q.id = qr.question_id
    JOIN question_type qt ON qt.id = q.type_id
    WHERE qr.student_assessment_id = ? AND qr.attribute_two_id IS NOT NULL
) attr_scores
GROUP BY attr_scores.attribute_id
```

#### 2. Deal-breaker Filter
```sql
-- Identical NOT EXISTS logic to exclude unsuitable careers
AND NOT EXISTS (
    SELECT 1
    FROM (
        -- Student score aggregation for all attributes (including excluded ones)
        SELECT attr_scores2.attribute_id,
               SUM(attr_scores2.value) / SUM(attr_scores2.max_value) as normalized_value,
               MIN(attr_scores2.question_type_name) as question_type_name
        FROM ( /* UNION ALL logic */ ) attr_scores2
        GROUP BY attr_scores2.attribute_id
    ) total_scores2
    JOIN career_attribute_zscore caz2 ON caz2.attribute_id = total_scores2.attribute_id
    WHERE caz2.career_id = ca.career_id
      AND total_scores2.normalized_value = -1      -- Student strongly dislikes
      AND caz2.z_score_value > 1.0                 -- Career requires highly
      AND total_scores2.question_type_name = 'Courses of Study'
)
```

#### 3. Core Scoring Formula
```sql
-- Identical weighted sum calculation
SUM(
    (total_scores.total_value / total_scores.max_possible_score) * 
    caz.z_score_value * 
    total_scores.scoring_weight
) AS match_score
```

### Parameter Management

Both preview and final scoring use consistent parameter ordering:

```java
// CareerService.buildMatchPreviewParameters()
Object[] parameters = {
    assessmentId,  // Main subquery
    assessmentId,  // First UNION: attribute_one responses  
    assessmentId,  // Second UNION: attribute_two responses
    assessmentId,  // WHERE clause filter
    assessmentId,  // Deal-breaker first UNION: attribute_one
    assessmentId,  // Deal-breaker second UNION: attribute_two
    clusterCode,   // Optional cluster filter
    topN           // Optional result limit
};

// ScoringService.buildScoringParameters() 
Object[] parameters = {
    assessmentId,  // INSERT student_assessment_id
    assessmentId,  // Main subquery
    assessmentId,  // First UNION: attribute_one responses
    assessmentId,  // Second UNION: attribute_two responses  
    assessmentId,  // WHERE clause filter
    assessmentId,  // Deal-breaker first UNION: attribute_one
    assessmentId   // Deal-breaker second UNION: attribute_two
};
```

## Verification & Testing

### Automated Verification
**End-to-End Test Results**:
```
CRITICAL TEST: Final Preview Consistency
Final matches: 295
Preview matches: 295
Match count is identical
CRITICAL TEST PASSED: Preview algorithm is IDENTICAL to final scoring!

Top 3 Career Matches Comparison:
✓ 1. Career 247 (2.301) → Career 247 (2.301) - Same Career, Same Score
✓ 2. Career 235 (2.235) → Career 235 (2.235) - Same Career, Same Score  
✓ 3. Career 211 (2.008) → Career 211 (2.008) - Same Career, Same Score

PERFECT MATCH! Both flows produced identical results
```

### Paranoid Logic Verification
Performed line-by-line comparison between original implementation and refactored version:

1. **SELECT Clause**: ✅ IDENTICAL
2. **Student Score Aggregation**: ✅ IDENTICAL  
3. **Career Matching JOINs**: ✅ IDENTICAL
4. **Deal-breaker Filter**: ✅ IDENTICAL
5. **GROUP BY and ORDER BY**: ✅ IDENTICAL
6. **Cluster Filter**: ✅ FUNCTIONALLY IDENTICAL

## Benefits Achieved

### 1. DRY Principle Compliance
- **Single Source of Truth**: All matching logic in `buildCareerMatchingCore()`
- **Zero Duplication**: Changes apply everywhere automatically
- **Consistency Guaranteed**: Impossible for preview/final to diverge

### 2. Maintainability Improvements
- **Centralized Logic**: Business rule changes in one place
- **Better Testability**: SQL generation can be unit tested independently
- **Clear Architecture**: Separation of concerns between service and SQL generation

### 3. Risk Reduction
- **No Logic Drift**: Preview and final scoring mathematically identical
- **Type Safety**: Consistent parameter handling across all methods
- **Validation Consistency**: Shared validation rules prevent edge case divergence

### 4. Code Quality Metrics
- **Lines of Code**: Reduced by ~200 lines through deduplication
- **Cyclomatic Complexity**: Simplified through parametrization  
- **Code Reuse**: 100% sharing of core algorithm between preview and final

## Future Considerations

### Extensibility
The parametrized design supports future requirements:
- Additional filtering options can be added as boolean parameters
- New output formats can be supported through format flags
- Algorithm modifications apply to all use cases automatically

### Performance
- **No Performance Impact**: Same SQL queries, just generated differently
- **Potential Optimization**: Centralized logic makes query optimization easier
- **Memory Efficiency**: No additional object creation during SQL generation

### Migration Safety
- **Zero Breaking Changes**: All existing API contracts preserved
- **Backward Compatibility**: All parameter formats maintained
- **Drop-in Replacement**: Service methods have identical signatures

## Files Modified

### New Files Created (2):
1. `src/main/java/com/pearson/pce/service/matching/MatchingSqlBuilder.java`
2. `src/main/java/com/pearson/pce/service/matching/MatchingValidationUtils.java`

### Existing Files Modified (2):
1. `src/main/java/com/pearson/pce/service/CareerService.java`
   - Removed: `buildMatchPreviewQuery()`, `validateSingleQuestionGroupPerAttribute()`
   - Updated: `previewMatches()` to use shared utilities

2. `src/main/java/com/pearson/pce/service/ScoringService.java`
   - Removed: duplicated `validateSingleQuestionGroupPerAttribute()`
   - Updated: `calculateCareerMatches()` to use shared utilities
   - Updated: `buildScoringParameters()` for new parameter schema

## Conclusion

Phase 6 refactoring successfully eliminated all code duplication while preserving 100% functional equivalence. The new architecture provides a solid foundation for future development with guaranteed consistency between preview and final scoring algorithms.

**Key Achievement**: True single source of truth for career matching logic - any future algorithm improvements will automatically benefit both preview and final scoring without risk of inconsistency.