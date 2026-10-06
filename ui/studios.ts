export const studios = [
 {id:'web', title:'Сайты и приложения', description:'Опишите задачу, получите исходники, проверку и ZIP проекта.', type:'AZRAIL', action:'Создать проект', cloud:true},
 {id:'image', title:'Изображения', description:'Обложки и визуальные идеи из текста через Workers AI.', type:'WORKERS AI', action:'Создать изображение', cloud:true},
 {id:'music', title:'Музыка', description:'Оригинальный музыкальный эскиз. Прослушивание, WAV и MIDI.', type:'НА УСТРОЙСТВЕ', action:'Создать эскиз', cloud:false},
 {id:'video', title:'Видео', description:'Типографическая анимация. Предпросмотр и экспорт WebM.', type:'НА УСТРОЙСТВЕ', action:'Записать видео', cloud:false},
 {id:'audio', title:'Аудиоанализ', description:'Спектр, динамика и сравнение с вашим референсом.', type:'НА УСТРОЙСТВЕ', action:'Проанализировать аудио', cloud:false},
 {id:'als', title:'Ableton', description:'Треки, темп и роли инструментов из ALS. Отчёт JSON.', type:'ОБЛАКО', action:'Проанализировать ALS', cloud:true},
 {id:'data', title:'Данные', description:'CSV: заполненность, числовая статистика и отчёт.', type:'НА УСТРОЙСТВЕ', action:'Проанализировать CSV', cloud:false},
 {id:'ledger', title:'Расходы', description:'Лимиты запросов и учтённые вызовы моделей ваших проектов.', type:'ОБЛАКО', action:'Обновить журнал', cloud:true},
 {id:'lab', title:'Pulse Lab', description:'Совместимость браузера и доступность подключённых сервисов.', type:'ДИАГНОСТИКА', action:'Проверить доступность', cloud:false},
] as const;
export type StudioId = typeof studios[number]['id'];
export function studioById(id:string) { return studios.find(studio=>studio.id===id); }
