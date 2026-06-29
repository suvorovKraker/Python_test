def check_even_numbers(numbers: list) -> bool:
    """Проверяет, что все элементы массива — числа и кратны двум."""
    for value in numbers:
        if not isinstance(value, (int, float)) or isinstance(value, bool):
            return False
        if value % 2 != 0:
            return False
    return True


numbers = [2, 4, 6, 8, 10]

if check_even_numbers(numbers):
    print("Все элементы — числа и кратны двум:", numbers)
else:
    print("Массив не прошёл проверку:", numbers)
