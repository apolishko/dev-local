# Partial Career Match E2E Testing Plan

## Цель

Расширить существующий e2e тест `studentJourney.ts` для валидации нового endpoint `GET /api/match/preview`, обеспечив **критически важную проверку** консистентности между preview алгоритмом и финальным scoring.

## Контекст

У нас уже есть мощная e2e инфраструктура:
- ✅ `studentJourney.ts` - сравнивает два flow (turn-by-turn vs batch-save) с идентичными ответами
- ✅ `ResponseGenerator` - детерминированные валидные ответы
- ✅ `ui-questions.json` - конфигурация вопросов из БД
- ✅ `compareCareerMatches()` - точное сравнение результатов

**Новая задача**: Добавить валидацию `GET /api/match/preview` endpoint для проверки что preview алгоритм **идентичен** финальному scoring.

## Приоритеты

### ПРИОРИТЕТ #1 (КРИТИЧЕСКИ ВАЖНО): Final Preview Consistency - DONE
**Цель**: Доказать что preview с полными данными === final results  
**Важность**: Core functionality validation

### ПРИОРИТЕТ #2 (НИЗКИЙ): Parameter Testing - NO NEEDED
**Цель**: Проверить работу clusterCode и topN параметров  
**Важность**: Secondary features

### ПРИОРИТЕТ #3 (НИЗКИЙ): Progressive Preview Testing  - DONE 
**Цель**: Мониторить изменения preview по мере добавления ответов  
**Важность**: UX insight и debugging

## Детальный План Реализации

### Phase 1: Core Consistency Validation (ПРИОРИТЕТ #1)

#### 1.1 Добавить типы и API методы

```typescript
// Новый тип для match preview response
type MatchPreviewResponse = {
    assessmentId: number;
    clusterCode?: string;
    results: Array<{ 
        careerId: number; 
        careerName: string; 
        matchScore: number 
    }>;
};

// Новый метод в PceApi класс
async getMatchPreview(
    assessmentId: number, 
    clusterCode?: string, 
    topN?: number
): Promise<MatchPreviewResponse> {
    return await this.request('get', '/api/match/preview', null, {
        assessmentId, clusterCode, topN
    });
}
```

#### 1.2 Создать критически важную функцию валидации

```typescript
/**
 * КРИТИЧЕСКИ ВАЖНЫЙ ТЕСТ: Preview с полными данными должен быть идентичен final results
 */
async function validateFinalPreviewConsistency(
    api: PceApi, 
    assessmentId: number, 
    finalMatches: CareerMatch[]
): Promise<void> {
    console.log(chalk.bold.red('\n🔥 CRITICAL TEST: Final Preview Consistency'));
    console.log(chalk.red('This test validates that preview algorithm === final scoring'));
    
    // Получить preview с полными данными (без параметров)
    const fullPreview = await api.getMatchPreview(assessmentId);
    
    console.log(chalk.yellow(`Final matches: ${finalMatches.length}`));
    console.log(chalk.yellow(`Preview matches: ${fullPreview.results.length}`));
    
    // КРИТИЧЕСКАЯ ПРОВЕРКА #1: Количество результатов должно совпадать
    if (finalMatches.length !== fullPreview.results.length) {
        throw new Error(
            `🚨 CRITICAL FAILURE: Different number of matches! ` +
            `Final: ${finalMatches.length}, Preview: ${fullPreview.results.length}`
        );
    }
    
    console.log(chalk.green('✅ Match count is identical'));
    
    // КРИТИЧЕСКАЯ ПРОВЕРКА #2: Каждый match должен быть идентичен
    const tolerance = 0.000001; // Очень строгая толерантность для floating point
    let allIdentical = true;
    
    for (let i = 0; i < finalMatches.length; i++) {
        const finalMatch = finalMatches[i];
        const previewMatch = fullPreview.results[i];
        
        // Career ID должен совпадать точно
        if (finalMatch.careerId !== previewMatch.careerId) {
            console.log(chalk.red(
                `❌ Position ${i}: Career mismatch! ` +
                `Final: ${finalMatch.careerId}, Preview: ${previewMatch.careerId}`
            ));
            allIdentical = false;
        }
        
        // Match score должен быть практически идентичен
        const scoreDiff = Math.abs(
            Number(finalMatch.matchScore) - Number(previewMatch.matchScore)
        );
        
        if (scoreDiff > tolerance) {
            console.log(chalk.red(
                `❌ Position ${i}: Score mismatch! ` +
                `Final: ${finalMatch.matchScore}, Preview: ${previewMatch.matchScore}, ` +
                `Diff: ${scoreDiff.toFixed(8)}`
            ));
            allIdentical = false;
        }
    }
    
    if (!allIdentical) {
        throw new Error('🚨 CRITICAL FAILURE: Preview results differ from final results!');
    }
    
    console.log(chalk.bold.green('🎉 CRITICAL TEST PASSED: Preview algorithm is IDENTICAL to final scoring!'));
    console.log(chalk.green('This confirms that the preview logic is 100% consistent with final results'));
}
```

#### 1.3 Интеграция в существующие flows

Добавить вызов после получения career matches в оба flow:

```typescript
// В runTurnByTurnSubmissionFlow() после STEP 5:
const matches = await api.getCareerMatches(assessment.id);

// 🔥 КРИТИЧЕСКИЙ ТЕСТ: Preview consistency
await validateFinalPreviewConsistency(api, assessment.id, matches);

// В runBatchSaveSubmissionFlow() после STEP 8:
const matches = await api.getCareerMatches(assessment.id);

// 🔥 КРИТИЧЕСКИЙ ТЕСТ: Preview consistency  
await validateFinalPreviewConsistency(api, assessment.id, matches);
```

### Phase 2: Parameter Testing (ПРИОРИТЕТ #2)

#### 2.1 Smart clusterCode Testing

```typescript
/**
 * Интеллектуальное тестирование параметров используя реальные данные студента
 */
async function validateParameterFunctionality(
    api: PceApi, 
    assessmentId: number, 
    finalMatches: CareerMatch[]
): Promise<void> {
    console.log(chalk.bold.blue('\n🔧 Parameter Testing (Secondary Priority)'));
    
    // Получить cluster codes из топ результатов
    const topCareers: CareerDetail[] = [];
    const clusterCodes = new Set<string>();
    
    for (const match of finalMatches.slice(0, 5)) {
        const career = await api.getCareerDetail(match.careerId);
        topCareers.push(career);
        if (career.clusterCode?.trim()) {
            clusterCodes.add(career.clusterCode.trim());
        }
    }
    
    console.log(chalk.blue(`Found cluster codes: [${Array.from(clusterCodes).join(', ')}]`));
    
    // Test clusterCode filtering
    for (const clusterCode of clusterCodes) {
        const clusterPreview = await api.getMatchPreview(assessmentId, clusterCode);
        
        // Validate all results belong to specified cluster
        for (const match of clusterPreview.results.slice(0, 3)) {
            const career = await api.getCareerDetail(match.careerId);
            if (career.clusterCode !== clusterCode) {
                throw new Error(
                    `Cluster filter failed! Career ${match.careerId} ` +
                    `has cluster "${career.clusterCode}" but was returned for "${clusterCode}"`
                );
            }
        }
        
        console.log(chalk.green(`✅ Cluster "${clusterCode}": filter works correctly`));
    }
    
    // Test topN parameter
    const topNTests = [1, 3, 5, 10];
    const fullPreview = await api.getMatchPreview(assessmentId);
    
    for (const topN of topNTests) {
        const limitedPreview = await api.getMatchPreview(assessmentId, null, topN);
        
        if (limitedPreview.results.length > topN) {
            throw new Error(`topN filter failed! Expected max ${topN}, got ${limitedPreview.results.length}`);
        }
        
        // Validate ordering (first N should match unlimited results)
        for (let i = 0; i < Math.min(limitedPreview.results.length, topN); i++) {
            if (limitedPreview.results[i].careerId !== fullPreview.results[i].careerId) {
                throw new Error(`topN ordering failed at position ${i}`);
            }
        }
        
        console.log(chalk.green(`✅ topN=${topN}: limit and ordering work correctly`));
    }
    
    console.log(chalk.bold.blue('✅ All parameter testing completed successfully!'));
}
```

### Phase 3: Progressive Preview Testing (ПРИОРИТЕТ #3)

#### 3.1 Monitor Preview Changes During Assessment

```typescript
/**
 * Мониторинг изменений preview по мере добавления ответов (для debugging)
 */
async function testProgressiveMatchPreview(
    api: PceApi, 
    assessmentId: number
): Promise<void> {
    console.log(chalk.bold.cyan('\n📈 Progressive Preview Testing (Low Priority)'));
    
    // Эта функция вызывается после каждого turn в основном flow
    // Показывает как preview результаты изменяются с накоплением данных
    
    try {
        const preview = await api.getMatchPreview(assessmentId);
        
        if (preview.results.length === 0) {
            console.log(chalk.gray('   No preview matches yet (not enough data)'));
        } else {
            const topMatch = preview.results[0];
            console.log(chalk.cyan(
                `   Preview: ${preview.results.length} matches, ` +
                `top career ${topMatch.careerId} (score: ${Number(topMatch.matchScore).toFixed(3)})`
            ));
        }
    } catch (error) {
        console.log(chalk.gray(`   Preview failed: ${error}`));
    }
}
```

## Implementation Timeline

### Minimal Viable Testing (Сейчас)
1. ✅ Добавить типы и API методы 
2. ✅ Реализовать `validateFinalPreviewConsistency()` 
3. ✅ Интегрировать в оба существующих flow
4. ✅ Запустить тест и убедиться что preview === final

### Enhanced Testing (Потом)  
1. 🔧 Добавить `validateParameterFunctionality()`
2. 📈 Добавить `testProgressiveMatchPreview()`
3. 📊 Расширенная статистика и логирование

## Ожидаемые Результаты

### При успешном тестировании:
```
🔥 CRITICAL TEST: Final Preview Consistency
Final matches: 156
Preview matches: 156
✅ Match count is identical
🎉 CRITICAL TEST PASSED: Preview algorithm is IDENTICAL to final scoring!
This confirms that the preview logic is 100% consistent with final results
```

### При провале (требует исправления):
```
🚨 CRITICAL FAILURE: Different number of matches! Final: 156, Preview: 148
```

## Файлы для Изменения

### Основные изменения:
- **`e2e-test/studentJourney.ts`** - добавить типы, API методы, validation функции
- **Integration points** - в `runTurnByTurnSubmissionFlow()` и `runBatchSaveSubmissionFlow()`

### Новых файлов не создаем - используем существующую инфраструктуру!

## Критерии Успеха

### MUST HAVE (Критически важно):
- ✅ Preview с полными данными **точно равен** final results
- ✅ Одинаковое количество результатов
- ✅ Идентичные career IDs в том же порядке  
- ✅ Match scores отличаются не более чем на 0.000001

### NICE TO HAVE (Низкий приоритет):
- 🔧 clusterCode фильтрация работает корректно
- 🔧 topN лимитирование работает корректно  
- 📈 Progressive preview показывает логичные изменения

## Заключение

Этот план позволяет:

1. **Критически важно**: Получить **железобетонную уверенность** что preview алгоритм идентичен final scoring
2. **Incrementally**: Начать с минимального критичного функционала, потом расширить
3. **Efficiently**: Переиспользовать всю существующую e2e инфраструктуру  
4. **Robustly**: Использовать детерминированные ответы для повторяемости результатов

**Результат**: Полная confidence что `GET /api/match/preview` работает точно так же как финальный scoring алгоритм, что критически важно для корректности "Choose Your Future" feature.