# 来源与许可

设置界面的前后端分工参考 Anima，后端仓库 https://github.com/Ellinav/anima-rag ，研究时固定快照 `4ee45d1`。其 LICENSE.txt 为 CC BY-NC 4.0，package.json 曾标 MIT，二者有差异；本项目未将该字段作为整体 MIT 授权依据。未直接复制 Anima 的后端、人物状态、世界书维护或酒馆助手代码，也没有要求其作者为本项目背书。

本项目的前后端接入、SQLite 存储、任务恢复、来源版本、请求副本转换、总结提示词和界面均为自行编写，以 CC BY-NC 4.0 提供；再分发保留 LICENSE 和本说明。测试依赖 Express 依其 MIT 许可；酒馆本身不随插件包分发。

适配基准 SillyTavern 1.19.0，提交 `06bde939fb1e9c4c8d8641d810f0a916b5bce127`。酒馆助手接口已作为研究参考，但本版功能使用酒馆原生上下文、事件和工具接口，没有硬性助手依赖。
